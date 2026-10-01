import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend, AgentEvent, StartOptions } from "./types";

/** Окно контекста по имени модели: haiku и старые 3.x — 200k, актуальные — 1M. */
function inferClaudeWindow(model: string): number {
  return /haiku|claude-3/i.test(model) ? 200_000 : 1_000_000;
}

/** Очередь входящих сообщений для потокового ввода SDK (push во время хода). */
class InputQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(value: T) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value, done: false });
    else this.items.push(value);
  }

  close() {
    this.closed = true;
    for (const w of this.waiters) w({ value: undefined as never, done: true });
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        this.items.length > 0
          ? Promise.resolve({ value: this.items.shift() as T, done: false })
          : this.closed
            ? Promise.resolve({ value: undefined as never, done: true })
            : new Promise((resolve) => this.waiters.push(resolve)),
    };
  }
}

/** Сообщение пользователя в формате потокового ввода SDK. */
function userMessage(text: string, priority?: "now" | "next" | "later") {
  return {
    type: "user" as const,
    message: { role: "user" as const, content: text },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  };
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
    // Внешний CLI (настройка agentHub.claude.cliPath): свежие модели сразу
    // после обновления claude, без перевыпуска плагина.
    if (opts.cliPath) options.pathToClaudeCodeExecutable = opts.cliPath;
    if (cfg.model) options.model = cfg.model;
    if (cfg.effort) options.effort = cfg.effort;
    if (cfg.maxTurns && cfg.maxTurns > 0) options.maxTurns = cfg.maxTurns;
    if (cfg.permissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }

    /** Модель сессии, как её объявляет сам CLI (init и события смены). */
    let currentModel = cfg.model ?? "";
    /** События из колбэков SDK (хуки) — выдаются в основном цикле. */
    const pendingEvents: AgentEvent[] = [];
    let lastSwitchKey = "";

    // Смена модели — ТОЛЬКО по явному сигналу CLI, без сравнения названий:
    // хук PostModelSwitch сообщает from/to и причину (auto = автофоллбэк).
    options.hooks = {
      PostModelSwitch: [
        {
          hooks: [
            async (input: unknown) => {
              const i = input as { from_model?: string; to_model?: string; source?: string };
              if (i.to_model) {
                const key = `${i.from_model ?? ""}>${i.to_model}`;
                currentModel = i.to_model;
                if (key !== lastSwitchKey) {
                  lastSwitchKey = key;
                  if (i.source === "auto" && i.from_model) {
                    pendingEvents.push({ kind: "model", model: i.to_model, fallbackFrom: i.from_model });
                    pendingEvents.push({
                      kind: "notice",
                      text: `⚠️ CLI автоматически сменил модель: ${i.from_model} → ${i.to_model}.`,
                    });
                  } else {
                    pendingEvents.push({ kind: "model", model: i.to_model });
                  }
                }
              }
              return {};
            },
          ],
        },
      ],
    };

    // Потоковый ввод: первое сообщение — промпт; пока ход идёт, хост может
    // докинуть сообщения (корректировка на лету) с приоритетом now/next.
    const input = new InputQueue<ReturnType<typeof userMessage>>();
    input.push(userMessage(prompt));
    let lastSteerAt = 0;
    let initCount = 0;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    if (opts.steer) {
      opts.steer.handler = async (text, mode) => {
        lastSteerAt = Date.now();
        input.push(userMessage(text, mode));
      };
    }

    const stream = query({
      prompt: input as unknown as Parameters<typeof query>[0]["prompt"],
      options: options as Parameters<typeof query>[0]["options"],
    });
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

    try {
    for await (const msg of stream) {
      while (pendingEvents.length > 0) yield pendingEvents.shift() as AgentEvent;
      // После result CLI начал новый ход по докинутому сообщению — ввод не закрываем.
      if (closeTimer && (msg.type === "assistant" || msg.type === "stream_event")) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") {
            yield { kind: "session", sessionId: msg.session_id };
            const model = (msg as unknown as { model?: string }).model;
            if (model) {
              currentModel = model;
              yield { kind: "model", model };
            }
            // Пока CLI жив — точный замер: окно модели + базовая занятость
            // (системный промпт, инструменты, память) ещё до первого шага.
            // Только на первом ходе сессии (~1.3 с): на resume окно уже известно.
            // Тяжёлые запросы — только на первом init свежей сессии: после
            // прерывания (режим «сразу») CLI присылает init повторно.
            const fresh = !opts.resumeSessionId && initCount++ === 0;
            if (fresh) try {
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
            if (fresh) try {
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
            // На первом ходе и когда хост считает кэш устаревшим (новые модели
            // появляются после обновления CLI — без пересоздания сессии).
            if (fresh || opts.refreshModels) try {
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
          } else if ((msg as { subtype?: string }).subtype === "model_refusal_fallback") {
            // Явный фоллбэк от CLI: модели — из самого события.
            const f = msg as unknown as {
              direction?: string;
              scope?: string;
              original_model?: string;
              fallback_model?: string;
            };
            if (f.scope !== "local" && f.original_model && f.fallback_model) {
              if (f.direction === "revert") {
                currentModel = f.original_model;
                lastSwitchKey = `${f.fallback_model}>${f.original_model}`;
                yield { kind: "model", model: f.original_model };
                yield { kind: "notice", text: `Модель восстановлена: ${f.original_model}.` };
              } else {
                currentModel = f.fallback_model;
                lastSwitchKey = `${f.original_model}>${f.fallback_model}`;
                yield { kind: "model", model: f.fallback_model, fallbackFrom: f.original_model };
                yield {
                  kind: "notice",
                  text: `⚠️ Сработал фоллбэк: ${f.original_model} → ${f.fallback_model} (модель отказалась отвечать).`,
                };
              }
            }
          } else if ((msg as { subtype?: string }).subtype === "model_refusal_no_fallback") {
            const f = msg as unknown as { content?: string };
            if (f.content) yield { kind: "notice", text: `⚠️ ${f.content}` };
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
          // Ход закрыт. Если прямо перед этим докинули сообщение, CLI может
          // начать по нему новый ход — даём 3 с, иначе закрываем ввод сразу.
          if (Date.now() - lastSteerAt < 5000) {
            closeTimer = setTimeout(() => input.close(), 3000);
          } else {
            input.close();
          }
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
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
      input.close();
      if (opts.steer) opts.steer.handler = undefined;
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
