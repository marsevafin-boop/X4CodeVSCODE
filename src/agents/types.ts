/**
 * Единый интерфейс бэкендов-агентов (раздел 8.3 ai-dev-environment.md).
 * ClaudeBackend — через @anthropic-ai/claude-agent-sdk.
 * CodexBackend  — появится на шаге 4 дорожной карты.
 */

/** Нормализованные события, которые бэкенд отдаёт наружу независимо от модели. */
export type AgentEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "activity"; label: string }
  | { kind: "textDelta"; text: string }
  | { kind: "assistantText"; text: string }
  | { kind: "toolUse"; toolName: string; summary: string }
  | {
      kind: "result";
      ok: boolean;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
    }
  | { kind: "contextUsage"; usedTokens: number; maxTokens: number }
  | {
      kind: "model";
      model: string;
      /** Заполнено, если модель фактически понижена фоллбэком с указанной. */
      fallbackFrom?: string;
    }
  | { kind: "notice"; text: string }
  | {
      /** Доступные slash-команды CLI (Claude отдаёт их после init). */
      kind: "commands";
      commands: { name: string; description?: string; argumentHint?: string }[];
    }
  | { kind: "error"; message: string };

/** Настройки агента из VS Code settings (модель, effort и т.п.). */
export interface AgentRunConfig {
  model?: string;
  effort?: string;
  permissionMode?: string;
  maxTurns?: number;
  sandbox?: string;
  /** Codex: --dangerously-bypass-approvals-and-sandbox (без песочницы и подтверждений). */
  yolo?: boolean;
  /** Окно контекста для индикатора; 0 — бэкенд определяет по модели. */
  contextWindow: number;
}

export interface StartOptions {
  /** Рабочая папка проекта, в которой действует агент. */
  cwd: string;
  /** id прошлой сессии для возобновления диалога. */
  resumeSessionId?: string;
  /** Дополнительные переменные окружения (например, пароль сервера из SecretStorage). */
  extraEnv?: Record<string, string>;
  /** Настройки модели/поведения агента. */
  config: AgentRunConfig;
  /** Абсолютные пути приложенных файлов (изображения Codex получает через -i). */
  attachments?: { path: string; isImage: boolean }[];
  /** Сигнал отмены (кнопка «Стоп»). */
  signal: AbortSignal;
  /**
   * Колбэк подтверждения инструмента.
   * allow=true — разрешить; allow=false + answer — пользователь ответил на
   * вопрос агента (AskUserQuestion), текст доставляется через deny-message.
   */
  confirmTool: (
    toolName: string,
    input: unknown,
  ) => Promise<{ allow: boolean; answer?: string }>;
}

export interface AgentBackend {
  readonly id: string;
  start(prompt: string, opts: StartOptions): AsyncIterable<AgentEvent>;
}
