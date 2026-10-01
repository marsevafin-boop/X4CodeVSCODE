import { spawn } from "node:child_process";
import * as readline from "node:readline";
import type { AgentBackend, AgentEvent, StartOptions } from "./types";
import {
  CodexBackend,
  WRITER_CONFLICT_RE,
  codexDefaultModel,
  hardKill,
  killStaleCodex,
  trackCodex,
  untrackCodex,
} from "./codexBackend";

type Json = Record<string, unknown>;
type End = { kind: "__end" };

/**
 * Бэкенд Codex через `codex app-server` — JSON-RPC по stdio, тот же протокол,
 * что у интерактивного CLI и приложения Codex. В отличие от `codex exec`:
 *  - turn/steer — докинуть сообщение в ИДУЩИЙ ход (корректировка на лету);
 *  - turn/interrupt — прервать ход и начать новый по уточнению (режим «сразу»);
 *  - ответ агента стримится дельтами;
 *  - вопросы пользователю (request_user_input) и подтверждения приходят
 *    серверными запросами и ЖДУТ ответа;
 *  - смена модели сообщается явно (model/rerouted).
 * Процесс живёт один ход: поднялся → initialize → thread/start|resume →
 * turn/start → события → turn/completed → завершение (как exec, блокировка
 * треда не удерживается между ходами).
 * Проверено на codex-cli 0.153.4. Если app-server недоступен (старый CLI) —
 * ход автоматически выполняется через exec-бэкенд.
 */
export class CodexAppServerBackend implements AgentBackend {
  readonly id = "codex";
  private readonly exec = new CodexBackend();

  async *start(prompt: string, opts: StartOptions): AsyncIterable<AgentEvent> {
    const cfg = opts.config;
    const sandbox = cfg.yolo ? "danger-full-access" : cfg.sandbox || "workspace-write";
    const startedAt = Date.now();

    if (opts.resumeSessionId && killStaleCodex(opts.resumeSessionId)) {
      yield {
        kind: "notice",
        text: "⚠️ Предыдущий процесс Codex этого треда ещё висел — завершён перед новым ходом.",
      };
      await new Promise((r) => setTimeout(r, 1000));
    }

    const child = spawn("codex", ["app-server"], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.extraEnv ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    // ---------- мост «колбэки → генератор» ----------
    const queue: (AgentEvent | End)[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const emit = (ev: AgentEvent | End) => {
      queue.push(ev);
      const w = wake;
      wake = null;
      w?.();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      emit({ kind: "__end" });
    };

    // ---------- JSON-RPC ----------
    let nextId = 0;
    const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
    const write = (obj: Json) => {
      if (child.stdin.writable) child.stdin.write(JSON.stringify(obj) + "\n");
    };
    const request = (method: string, params: Json) =>
      new Promise<Json>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        write({ id, method, params });
      });

    let threadId: string | null = opts.resumeSessionId ?? null;
    let turnId: string | null = null;
    /** Режим «сразу»: текст, с которым стартует новый ход после прерывания. */
    let restartWith: string | null = null;
    const seenItems = new Set<string>();
    const deltaItems = new Set<string>();
    /** Между двумя сообщениями агента подряд нужен разрыв абзаца. */
    let needBreak = false;
    const stderrChunks: string[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c.toString()));

    const windowFor = (fromServer?: number | null) =>
      cfg.contextWindow > 0 ? cfg.contextWindow : (fromServer ?? 400_000);

    const turnInput = (text: string, withImages: boolean): Json[] => [
      { type: "text", text },
      ...(withImages
        ? (opts.attachments ?? [])
            .filter((a) => a.isImage)
            .map((a) => ({ type: "localImage", path: a.path }))
        : []),
    ];
    const startTurn = async (text: string, withImages: boolean) => {
      const r = await request("turn/start", {
        threadId,
        input: turnInput(text, withImages),
        ...(cfg.effort ? { effort: cfg.effort } : {}),
      });
      turnId = ((r.turn as Json | undefined)?.id as string | undefined) ?? turnId;
    };

    // ---------- серверные запросы (ждут ответа) ----------
    const handleServerRequest = async (method: string, p: Json): Promise<Json> => {
      if (method === "item/tool/requestUserInput") {
        const answers: Record<string, { answers: string[] }> = {};
        const questions = (p.questions as Json[] | undefined) ?? [];
        for (const q of questions) {
          const res = await opts.confirmTool("AskUserQuestion", {
            questions: [{ question: q.question, options: q.options ?? [] }],
          });
          answers[String(q.id)] = { answers: res.answer ? [res.answer] : [] };
        }
        return { answers };
      }
      if (method === "item/commandExecution/requestApproval") {
        const res = await opts.confirmTool("Bash", {
          command: (p.command as string | null) ?? "",
          description: (p.reason as string | null) ?? undefined,
        });
        return { decision: res.allow ? "accept" : "decline" };
      }
      if (method === "item/fileChange/requestApproval") {
        const res = await opts.confirmTool("Edit", {
          file_path: (p.grantRoot as string | null) ?? "(изменение файлов)",
          description: (p.reason as string | null) ?? undefined,
        });
        return { decision: res.allow ? "accept" : "decline" };
      }
      if (method === "item/permissions/requestApproval") {
        return { permissions: {} }; // расширение прав не выдаём
      }
      throw new Error(`unsupported server request: ${method}`);
    };

    // ---------- уведомления ----------
    const handleNotification = (method: string, p: Json) => {
      const item = (p.item as (Json & { id?: string; type?: string }) | undefined) ?? undefined;
      switch (method) {
        case "turn/started": {
          const t = p.turn as Json | undefined;
          if (typeof t?.id === "string") turnId = t.id;
          emit({ kind: "activity", label: "Думает…" });
          break;
        }
        case "item/agentMessage/delta": {
          const id = String(p.itemId ?? "");
          if (!deltaItems.has(id) && needBreak) emit({ kind: "textDelta", text: "\n\n" });
          deltaItems.add(id);
          needBreak = false;
          if (typeof p.delta === "string" && p.delta) emit({ kind: "textDelta", text: p.delta });
          break;
        }
        case "item/started": {
          if (!item?.type) break;
          if (item.type === "reasoning") {
            emit({ kind: "activity", label: "Думает…" });
          } else if (item.type === "agentMessage") {
            emit({ kind: "activity", label: "Пишет ответ…" });
          } else if (item.type !== "userMessage" && item.type !== "hookPrompt") {
            const key = item.id ?? JSON.stringify(item);
            if (seenItems.has(key)) break;
            seenItems.add(key);
            const summary = String(
              item.command ?? item.query ?? item.tool ?? item.path ?? item.text ?? "",
            );
            if (item.type === "commandExecution") {
              emit({ kind: "activity", label: `Выполняет: ${summary.slice(0, 60)}…` });
            }
            if (item.type === "contextCompaction") {
              emit({ kind: "notice", text: "Контекст сжат (compaction)." });
            } else {
              emit({ kind: "toolUse", toolName: item.type, summary });
            }
            needBreak = true;
          }
          break;
        }
        case "item/completed": {
          if (item?.type !== "agentMessage") break;
          const questions = normalizeQuestions(item.questions);
          if (questions) {
            // request_user_input_async: Codex не ждёт — карточка + ответ следующим ходом.
            emit({ kind: "question", id: item.id ?? "", questions });
          } else if (!deltaItems.has(item.id ?? "") && typeof item.text === "string" && item.text) {
            emit({ kind: "assistantText", text: item.text });
          }
          needBreak = true;
          break;
        }
        case "thread/tokenUsage/updated": {
          const u = p.tokenUsage as
            | { last?: { totalTokens?: number }; modelContextWindow?: number | null }
            | undefined;
          const used = u?.last?.totalTokens ?? 0;
          if (used > 0) {
            emit({
              kind: "contextUsage",
              usedTokens: used,
              maxTokens: windowFor(u?.modelContextWindow),
            });
          }
          break;
        }
        case "model/rerouted": {
          // Явный сигнал смены модели от Codex — без сравнения названий.
          const from = String(p.fromModel ?? "");
          const to = String(p.toModel ?? "");
          if (to) {
            emit({ kind: "model", model: to, ...(from ? { fallbackFrom: from } : {}) });
            emit({ kind: "notice", text: `⚠️ Codex сменил модель: ${from} → ${to}.` });
          }
          break;
        }
        case "error": {
          const e = p.error as { message?: string } | undefined;
          const text = e?.message ?? "Codex: ошибка";
          if (p.willRetry) emit({ kind: "notice", text: `Codex: ${text} — повторяет…` });
          else emit({ kind: "error", message: text });
          break;
        }
        case "thread/compacted":
          emit({ kind: "notice", text: "Контекст сжат (compaction)." });
          break;
        case "turn/completed": {
          const t = (p.turn as { status?: string; error?: { message?: string } | null }) ?? {};
          if (t.status === "interrupted" && restartWith !== null) {
            // Режим «сразу»: прервали — стартуем новый ход с уточнением.
            const text = restartWith;
            restartWith = null;
            needBreak = true;
            startTurn(text, false).catch((err: Error) => {
              emit({ kind: "error", message: `Codex: не удалось продолжить после прерывания: ${err.message}` });
              emit({ kind: "result", ok: false, durationMs: Date.now() - startedAt });
              finish();
            });
            break;
          }
          if (t.status === "failed") {
            emit({ kind: "error", message: t.error?.message ?? "Codex: ход завершился с ошибкой" });
          }
          emit({
            kind: "result",
            ok: t.status === "completed",
            durationMs: Date.now() - startedAt,
          });
          finish();
          break;
        }
      }
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let m: Json;
      try {
        m = JSON.parse(line) as Json;
      } catch {
        return;
      }
      const id = m.id as number | undefined;
      if (id !== undefined && (m.result !== undefined || m.error !== undefined) && pending.has(id)) {
        const pr = pending.get(id);
        pending.delete(id);
        if (m.error) {
          pr?.reject(new Error(String((m.error as { message?: string }).message ?? JSON.stringify(m.error))));
        } else {
          pr?.resolve((m.result as Json) ?? {});
        }
        return;
      }
      if (typeof m.method === "string" && id !== undefined) {
        handleServerRequest(m.method, (m.params as Json) ?? {})
          .then((result) => write({ id, result }))
          .catch((err: Error) => write({ id, error: { code: -32601, message: err.message } }));
        return;
      }
      if (typeof m.method === "string") handleNotification(m.method, (m.params as Json) ?? {});
    });

    let spawnError: Error | null = null;
    child.on("error", (err) => {
      spawnError = err;
      for (const pr of pending.values()) pr.reject(err);
      pending.clear();
      finish();
    });
    child.on("exit", (code) => {
      for (const pr of pending.values()) pr.reject(new Error(`codex app-server завершился (код ${code})`));
      pending.clear();
      if (!finished && !opts.signal.aborted) {
        const stderr = stderrChunks.join("").trim();
        emit({
          kind: "error",
          message:
            `Codex (app-server) завершился (код ${code}) без результата.` +
            (stderr ? `\n${stderr.slice(-600)}` : ""),
        });
        emit({ kind: "result", ok: false, durationMs: Date.now() - startedAt });
      }
      finish();
    });

    const onAbort = () => {
      // Мягко прерываем ход (тред допишется), затем добиваем процесс.
      if (threadId && turnId) write({ id: ++nextId, method: "turn/interrupt", params: { threadId, turnId } });
      setTimeout(() => hardKill(child), 1500).unref();
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    try {
      // ---------- рукопожатие и запуск хода ----------
      let threadReady = false;
      try {
        await request("initialize", {
          clientInfo: { name: "agent-hub", title: "Agent Hub", version: "1.0.0" },
        });
        write({ method: "initialized", params: {} });
        const common: Json = {
          cwd: opts.cwd,
          sandbox,
          approvalPolicy: "never",
          ...(cfg.model ? { model: cfg.model } : {}),
        };
        const th = opts.resumeSessionId
          ? await request("thread/resume", { threadId: opts.resumeSessionId, ...common })
          : await request("thread/start", common);
        threadId = String((th.thread as Json | undefined)?.id ?? threadId ?? "");
        threadReady = true;
        if (threadId) {
          trackCodex(threadId, child);
          yield { kind: "session", sessionId: threadId };
        }
        const model = (th.model as string | undefined) || cfg.model || codexDefaultModel();
        if (model) yield { kind: "model", model };
        await startTurn(prompt, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stderr = stderrChunks.join("");
        hardKill(child);
        if (opts.signal.aborted) return;
        if (opts.resumeSessionId && WRITER_CONFLICT_RE.test(message + stderr)) {
          yield {
            kind: "error",
            message:
              "Codex не может продолжить тред: его держит другой процесс codex (thread-store conflict).\n" +
              message.slice(0, 300),
            code: "codexWriterConflict",
            threadId: opts.resumeSessionId,
          };
          yield { kind: "result", ok: false, durationMs: Date.now() - startedAt };
          return;
        }
        if (!threadReady && !spawnError) {
          // app-server не поднялся/не понял протокол (старый CLI) — работаем через exec.
          yield {
            kind: "notice",
            text: `codex app-server недоступен (${message.slice(0, 120)}) — ход выполняется через exec, без корректировки на лету.`,
          };
          yield* this.exec.start(prompt, opts);
          return;
        }
        yield { kind: "error", message: `Codex: ${message}` };
        yield { kind: "result", ok: false, durationMs: Date.now() - startedAt };
        return;
      }

      // ---------- корректировка на лету ----------
      if (opts.steer) {
        opts.steer.handler = async (text, mode) => {
          if (!threadId || !turnId || finished) throw new Error("ход уже завершён");
          if (mode === "now") {
            restartWith = text;
            await request("turn/interrupt", { threadId, turnId });
            return;
          }
          await request("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: [{ type: "text", text }],
          });
        };
      }

      // ---------- выдача событий ----------
      for (;;) {
        while (queue.length > 0) {
          const ev = queue.shift() as AgentEvent | End;
          if (ev.kind === "__end") return;
          yield ev;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      if (opts.steer) opts.steer.handler = undefined;
      rl.close();
      if (child.exitCode === null) hardKill(child);
      if (threadId) {
        const key = threadId;
        if (child.exitCode !== null) untrackCodex(key, child);
        else child.once("exit", () => untrackCodex(key, child));
      }
    }
  }
}

/** Вопросы request_user_input из agentMessage.questions (строки или {label, description}). */
function normalizeQuestions(
  raw: unknown,
): { title: string; options: { label: string; description?: string }[] }[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: { title: string; options: { label: string; description?: string }[] }[] = [];
  for (const q of raw as { title?: unknown; question?: unknown; options?: unknown }[]) {
    const title =
      typeof q?.title === "string" ? q.title : typeof q?.question === "string" ? q.question : "";
    if (!title) continue;
    const options = Array.isArray(q.options)
      ? (q.options as unknown[])
          .map((o) => {
            if (typeof o === "string") return { label: o };
            const obj = o as { label?: unknown; description?: unknown };
            return {
              label: typeof obj?.label === "string" ? obj.label : "",
              description: typeof obj?.description === "string" ? obj.description : undefined,
            };
          })
          .filter((o) => o.label)
      : [];
    out.push({ title, options });
  }
  return out.length > 0 ? out : null;
}
