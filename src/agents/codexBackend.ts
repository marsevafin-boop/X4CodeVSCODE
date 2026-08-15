import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentBackend, AgentEvent, StartOptions } from "./types";

/** Модель по умолчанию из ~/.codex/config.toml (когда в настройках не задана). */
function codexDefaultModel(): string | null {
  try {
    const toml = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
    const m = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Точная занятость контекста Codex — из rollout-файла сессии
 * (~/.codex/sessions/ГГГГ/ММ/ДД/rollout-*-<thread_id>.jsonl): там на каждый
 * запрос пишется token_count с last_token_usage.total_tokens (= промпт
 * последнего запроса + его выход) и model_context_window.
 * В --json стриме этих данных нет, а turn.completed.usage — накопительный
 * за всю сессию и для занятости контекста непригоден.
 */
async function readCodexContext(
  threadId: string,
  cache: { file?: string },
): Promise<{ used: number; window?: number } | null> {
  try {
    if (!cache.file) {
      const root = path.join(os.homedir(), ".codex", "sessions");
      const entries = (await fs.promises.readdir(root, { recursive: true })) as string[];
      const suffix = `-${threadId}.jsonl`;
      const rel = entries.find((e) => e.endsWith(suffix));
      if (!rel) return null;
      cache.file = path.join(root, rel);
    }

    // Читаем хвост файла — свежие token_count в конце.
    const stat = await fs.promises.stat(cache.file);
    const readSize = Math.min(stat.size, 256 * 1024);
    const fd = await fs.promises.open(cache.file, "r");
    const buf = Buffer.alloc(readSize);
    await fd.read(buf, 0, readSize, stat.size - readSize);
    await fd.close();

    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue;
      try {
        const j = JSON.parse(lines[i]) as {
          payload?: {
            info?: {
              last_token_usage?: { total_tokens?: number };
              model_context_window?: number;
            };
          };
        };
        const info = j.payload?.info;
        const used = info?.last_token_usage?.total_tokens;
        if (used && used > 0) {
          return { used, window: info?.model_context_window };
        }
      } catch {
        // строка обрезана границей буфера — берём предыдущую
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Бэкенд Codex CLI (OpenAI) через `codex exec --json` — JSONL-события в stdout.
 * Проверено на codex-cli 0.147.0: thread.started / item.* / turn.completed.
 *
 * ВАЖНО: у codex exec нет колбэка подтверждений (аналога canUseTool) —
 * он работает неинтерактивно в песочнице workspace-write: запись только
 * в рабочую папку, команды без выхода в сеть. Карточки подтверждений
 * поэтому появляются только у Claude.
 */
export class CodexBackend implements AgentBackend {
  readonly id = "codex";

  async *start(prompt: string, opts: StartOptions): AsyncIterable<AgentEvent> {
    const cfg = opts.config;
    const sandbox = cfg.sandbox || "workspace-write";
    const modelFlags = [
      ...(cfg.model ? ["-m", cfg.model] : []),
      ...(cfg.effort ? ["-c", `model_reasoning_effort="${cfg.effort}"`] : []),
    ];
    // Изображения Codex принимает нативно (vision) через -i.
    const imageFlags = (opts.attachments ?? [])
      .filter((a) => a.isImage)
      .flatMap((a) => ["-i", a.path]);
    // YOLO: полностью без песочницы и подтверждений. Иначе — заданная песочница.
    const sandboxFresh = cfg.yolo
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : ["-s", sandbox];
    const sandboxResume = cfg.yolo
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : ["-c", `sandbox_mode="${sandbox}"`];
    const args = opts.resumeSessionId
      ? [
          "exec",
          "resume",
          "--json",
          "--skip-git-repo-check",
          ...sandboxResume,
          ...modelFlags,
          ...imageFlags,
          opts.resumeSessionId,
          "-", // промпт из stdin
        ]
      : [
          "exec",
          "--json",
          "--skip-git-repo-check",
          "-C",
          opts.cwd,
          ...sandboxFresh,
          ...modelFlags,
          ...imageFlags,
          "-", // промпт из stdin
        ];

    const child = spawn("codex", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.extraEnv ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(prompt);
    child.stdin.end();

    const kill = () => {
      child.kill("SIGTERM");
      // Codex может игнорировать SIGTERM посреди запроса — добиваем.
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000);
    };
    opts.signal.addEventListener("abort", kill, { once: true });

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));

    const startedAt = Date.now();
    const seenItems = new Set<string>();
    let finished = false;
    let threadId: string | null = opts.resumeSessionId ?? null;
    const rolloutCache: { file?: string } = {};
    let lastContextReadAt = 0;

    const contextWindowFor = (fromRollout?: number) =>
      cfg.contextWindow > 0 ? cfg.contextWindow : (fromRollout ?? 400_000);

    try {
      const rl = readline.createInterface({ input: child.stdout });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line);
        } catch {
          continue; // не-JSON строки (баннеры) пропускаем
        }

        switch (ev.type) {
          case "thread.started": {
            if (typeof ev.thread_id === "string") {
              threadId = ev.thread_id;
              yield { kind: "session", sessionId: ev.thread_id };
            }
            const model = cfg.model || codexDefaultModel();
            if (model) yield { kind: "model", model };
            break;
          }

          case "turn.started":
            yield { kind: "activity", label: "Думает…" };
            break;

          case "item.started":
          case "item.completed": {
            const item = ev.item as
              | { id?: string; type?: string; text?: string; command?: string }
              | undefined;
            if (!item?.type) break;

            if (item.type === "agent_message" && ev.type === "item.completed") {
              if (item.text) yield { kind: "assistantText", text: item.text };
              break;
            }

            if (item.type === "reasoning") {
              yield { kind: "activity", label: "Думает…" };
              break;
            }

            // Команды и другие действия показываем чипом один раз на item.id.
            if (item.type !== "agent_message") {
              const key = item.id ?? JSON.stringify(item);
              if (!seenItems.has(key)) {
                seenItems.add(key);
                if (ev.type === "item.started" && item.type === "command_execution") {
                  yield {
                    kind: "activity",
                    label: `Выполняет: ${(item.command ?? "").slice(0, 60)}…`,
                  };
                }
                yield {
                  kind: "toolUse",
                  toolName: item.type,
                  summary: item.command ?? item.text ?? "",
                };
              }
            }

            // Живое обновление контекста по ходу выполнения (не чаще раза в 2 с).
            if (
              ev.type === "item.completed" &&
              threadId &&
              Date.now() - lastContextReadAt > 2000
            ) {
              lastContextReadAt = Date.now();
              const ctx = await readCodexContext(threadId, rolloutCache);
              if (ctx) {
                yield {
                  kind: "contextUsage",
                  usedTokens: ctx.used,
                  maxTokens: contextWindowFor(ctx.window),
                };
              }
            }
            break;
          }

          case "turn.completed": {
            finished = true;
            yield { kind: "result", ok: true, durationMs: Date.now() - startedAt };
            // Финальный точный замер из rollout-файла. turn.completed.usage
            // НЕ используем: он накопительный за всю сессию (включая resume)
            // и завышает занятость в разы.
            if (threadId) {
              const ctx = await readCodexContext(threadId, rolloutCache);
              if (ctx) {
                yield {
                  kind: "contextUsage",
                  usedTokens: ctx.used,
                  maxTokens: contextWindowFor(ctx.window),
                };
              }
            }
            break;
          }

          case "turn.failed": {
            finished = true;
            const err = ev.error as { message?: string } | undefined;
            yield { kind: "error", message: err?.message ?? "Codex: ход завершился с ошибкой" };
            yield { kind: "result", ok: false, durationMs: Date.now() - startedAt };
            break;
          }

          case "error":
            yield {
              kind: "error",
              message: typeof ev.message === "string" ? ev.message : "Codex: ошибка",
            };
            break;
        }
      }

      const exitCode: number = await new Promise((resolve) =>
        child.on("close", (code) => resolve(code ?? 0)),
      );
      if (!finished && !opts.signal.aborted) {
        const stderr = stderrChunks.join("").trim();
        yield {
          kind: "error",
          message:
            `Codex завершился (код ${exitCode}) без результата.` +
            (stderr ? `\n${stderr.slice(-800)}` : ""),
        };
        yield { kind: "result", ok: false, durationMs: Date.now() - startedAt };
      }
    } finally {
      opts.signal.removeEventListener("abort", kill);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }
}
