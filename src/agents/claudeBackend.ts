import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend, AgentEvent, StartOptions } from "./types";

/** Окно контекста по имени модели: haiku и старые 3.x — 200k, актуальные — 1M. */
function inferClaudeWindow(model: string): number {
  return /haiku|claude-3/i.test(model) ? 200_000 : 1_000_000;
}

/** Канонизация id модели для сравнения (без датированного суффикса). */
function canonicalModel(m: string): string {
  return m.replace(/-\d{8}$/, "");
}

/**
 * Бэкенд Claude через @anthropic-ai/claude-agent-sdk.
 * SDK оборачивает CLI Claude Code и использует его авторизацию (подписка Max).
 * ВАЖНО: ANTHROPIC_API_KEY вычищается из окружения — иначе биллинг уйдёт
 * в pay-as-you-go вместо подписки (раздел 8.2 ai-dev-environment.md).
 */
export class ClaudeBackend implements AgentBackend {
  readonly id = "claude";

  async *start(prompt: string, opts: StartOptions): AsyncIterable<AgentEvent> {
    const abortController = new AbortController();
    opts.signal.addEventListener("abort", () => abortController.abort(), { once: true });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "ANTHROPIC_API_KEY") env[k] = v;
    }
    Object.assign(env, opts.extraEnv ?? {});

    const cfg = opts.config;
    // Часть опций (model, effort, maxTurns) — новее строгих типов SDK,
    // поэтому собираем объект отдельно и добавляем их динамически.
    const options: Record<string, unknown> = {
      cwd: opts.cwd,
      resume: opts.resumeSessionId,
      abortController,
      env,
      permissionMode: cfg.permissionMode ?? "default",
      includePartialMessages: true,
      // Подхватываем CLAUDE.md и настройки проекта — общая память живёт в файлах.
      settingSources: ["user", "project", "local"],
      canUseTool: async (toolName: string, input: unknown) => {
        const res = await opts.confirmTool(toolName, input);
        if (res.allow) {
          return { behavior: "allow" as const, updatedInput: input };
        }
        return {
          behavior: "deny" as const,
          message: res.answer
            ? `Ответ пользователя: ${res.answer}. Продолжай с учётом этого выбора, не переспрашивая.`
            : "Пользователь отклонил операцию.",
        };
      },
    };
    if (cfg.model) options.model = cfg.model;
    if (cfg.effort) options.effort = cfg.effort;
    if (cfg.maxTurns && cfg.maxTurns > 0) options.maxTurns = cfg.maxTurns;
    if (cfg.permissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }

    const stream = query({
      prompt,
      options: options as Parameters<typeof query>[0]["options"],
    });

    let currentModel = cfg.model ?? "";
    /** Модель сессии из init — то, что «должно» работать. */
    let sessionModel = "";
    /** Фактически обслуживающая модель (меняется при серверном фоллбэке). */
    let servingModel = "";
    /**
     * Занятость контекста = размер промпта ПОСЛЕДНЕГО запроса + его выход
     * (in + cache_read + cache_write + out одного API-вызова). Суммировать
     * usage из result нельзя — там кэш пересчитан по разу на каждый шаг.
     */
    let lastRequestTokens = 0;
    /** Окно модели, полученное от CLI (авторитетнее таблицы-догадки). */
    let knownWindow = 0;
    const windowFor = () =>
      cfg.contextWindow > 0
        ? cfg.contextWindow
        : knownWindow > 0
          ? knownWindow
          : inferClaudeWindow(currentModel);

    for await (const msg of stream) {
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") {
            yield { kind: "session", sessionId: msg.session_id };
            const model = (msg as unknown as { model?: string }).model;
            if (model) {
              currentModel = model;
              sessionModel = model;
              servingModel = model;
              yield { kind: "model", model };
            }
            // Пока CLI жив — точный замер: окно модели + базовая занятость
            // (системный промпт, инструменты, память) ещё до первого шага.
            // Только на первом ходе сессии (~1.3 с): на resume окно уже известно.
            if (opts.resumeSessionId) break;
            try {
              const ctx = (await Promise.race([
                stream.getContextUsage(),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("timeout")), 2000),
                ),
              ])) as { totalTokens?: number; maxTokens?: number };
              if (ctx?.maxTokens) knownWindow = ctx.maxTokens;
              if (ctx?.totalTokens && ctx.maxTokens) {
                lastRequestTokens = ctx.totalTokens;
                yield {
                  kind: "contextUsage",
                  usedTokens: ctx.totalTokens,
                  maxTokens: windowFor(),
                };
              }
            } catch {
              // не критично — далее считаем по шагам
            }
            // Список slash-команд CLI (встроенные + .claude/commands) — для
            // меню автодополнения. Только на первом ходе, кэшируется хостом.
            try {
              const commands = (await Promise.race([
                stream.supportedCommands(),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("timeout")), 2500),
                ),
              ])) as { name: string; description?: string; argumentHint?: string }[];
              if (Array.isArray(commands) && commands.length > 0) {
                yield {
                  kind: "commands",
                  commands: commands.map((c) => ({
                    name: c.name,
                    description: c.description,
                    argumentHint: c.argumentHint,
                  })),
                };
              }
            } catch {
              // список команд не критичен
            }
            // Актуальные модели CLI (+ уровни effort каждой) — для пикеров.
            // Только на первом ходе, кэшируется хостом.
            try {
              const models = (await Promise.race([
                stream.supportedModels(),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("timeout")), 2500),
                ),
              ])) as {
                value: string;
                displayName?: string;
                description?: string;
                supportedEffortLevels?: string[];
              }[];
              if (Array.isArray(models) && models.length > 0) {
                yield {
                  kind: "models",
                  models: models.map((m) => ({
                    value: m.value,
                    displayName: m.displayName,
                    description: m.description,
                    supportedEffortLevels: m.supportedEffortLevels,
                  })),
                };
              }
            } catch {
              // список моделей не критичен
            }
          } else if ((msg as { subtype?: string }).subtype === "local_command_output") {
            // Вывод локальной slash-команды (/usage, /model и т.п.) — в ленту.
            const content = (msg as unknown as { content?: string }).content;
            if (content) yield { kind: "assistantText", text: content };
          } else if ((msg as { subtype?: string }).subtype === "informational") {
            // Баннеры цикла (в т.ч. вывод части slash-команд); info-уровень — шум.
            const info = msg as unknown as { content?: string; level?: string };
            if (info.content && info.level && info.level !== "info") {
              yield { kind: "notice", text: info.content };
            }
          } else if ((msg as { subtype?: string }).subtype === "compact_boundary") {
            const meta = (msg as unknown as { compact_metadata?: { pre_tokens?: number } })
              .compact_metadata;
            yield {
              kind: "notice",
              text: `Контекст сжат (compaction)${meta?.pre_tokens ? `: было ~${meta.pre_tokens.toLocaleString("ru-RU")} токенов` : ""}.`,
            };
            yield { kind: "activity", label: "Контекст сжат, продолжает…" };
          }
          break;

        case "stream_event": {
          const ev = msg.event;
          // Посимвольный стриминг текста ответа.
          if (
            ev.type === "content_block_delta" &&
            ev.delta.type === "text_delta"
          ) {
            yield { kind: "textDelta", text: ev.delta.text };
          }
          // Индикатор активности: что модель делает прямо сейчас.
          if (ev.type === "content_block_start") {
            const block = ev.content_block;
            if (block.type === "thinking") {
              yield { kind: "activity", label: "Думает…" };
            } else if (block.type === "text") {
              yield { kind: "activity", label: "Пишет ответ…" };
            } else if (block.type === "tool_use") {
              yield { kind: "activity", label: `Готовит вызов: ${block.name}…` };
            }
          }
          break;
        }

        case "user":
          // Пришёл результат инструмента — модель снова размышляет.
          yield { kind: "activity", label: "Обрабатывает результат…" };
          break;

        case "assistant": {
          // Живой учёт контекста: usage каждого assistant-сообщения — это один
          // API-вызов. Шаги суб-агентов (parent_tool_use_id) не считаем — у них
          // свой контекст.
          const parentId = (msg as unknown as { parent_tool_use_id?: string | null })
            .parent_tool_use_id;
          if (!parentId) {
            // Автодетект фоллбэка: message.model — модель, реально обслужившая
            // ЭТОТ ответ. При серверном фоллбэке (opus5/fable5 → запасная) она
            // отличается от модели сессии из init.
            const actual = (msg.message as unknown as { model?: string }).model;
            if (actual && sessionModel && canonicalModel(actual) !== canonicalModel(servingModel)) {
              const downgraded = canonicalModel(actual) !== canonicalModel(sessionModel);
              servingModel = actual;
              if (downgraded) {
                yield { kind: "model", model: actual, fallbackFrom: sessionModel };
                yield {
                  kind: "notice",
                  text: `⚠️ Сработал фоллбэк: ответ обслуживает ${actual} вместо ${sessionModel}.`,
                };
              } else {
                yield { kind: "model", model: actual };
                yield { kind: "notice", text: `Модель восстановлена: ${actual}.` };
              }
            }
            const u = (msg.message as unknown as { usage?: Record<string, number> }).usage;
            if (u) {
              const used =
                (u.input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0) +
                (u.output_tokens ?? 0);
              if (used > 0) {
                lastRequestTokens = used;
                yield { kind: "contextUsage", usedTokens: used, maxTokens: windowFor() };
              }
            }
          }

          // Текст уже пришёл дельтами; отсюда берём только вызовы инструментов.
          for (const block of msg.message.content) {
            if (block.type === "tool_use") {
              yield {
                kind: "toolUse",
                toolName: block.name,
                summary: summarizeToolInput(block.name, block.input),
              };
            }
          }
          break;
        }

        case "result": {
          yield {
            kind: "result",
            ok: msg.subtype === "success",
            costUsd: msg.total_cost_usd,
            durationMs: msg.duration_ms,
            numTurns: msg.num_turns,
          };

          // Финальный замер: занятость = последний запрос; окно уточняем из
          // modelUsage (после result CLI уже закрыт — getContextUsage недоступен,
          // авторитетный замер делается после init).
          if (lastRequestTokens > 0) {
            const mu = (
              msg as unknown as {
                modelUsage?: Record<
                  string,
                  { contextWindow?: number; canonicalModel?: string }
                >;
              }
            ).modelUsage;
            const entry =
              mu?.[currentModel] ??
              Object.values(mu ?? {}).find((e) => e.canonicalModel === currentModel);
            if (entry?.contextWindow && knownWindow === 0) {
              knownWindow = entry.contextWindow;
            }
            yield { kind: "contextUsage", usedTokens: lastRequestTokens, maxTokens: windowFor() };
          }
          break;
        }
      }
    }
  }
}

/** Короткая человекочитаемая подпись вызова инструмента для ленты чата. */
function summarizeToolInput(toolName: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const obj = input as Record<string, unknown>;
  const candidate =
    obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.url ?? obj.query;
  const text = typeof candidate === "string" ? candidate : JSON.stringify(obj);
  return text.length > 120 ? text.slice(0, 120) + "…" : text;
}
