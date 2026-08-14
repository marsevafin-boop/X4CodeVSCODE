/**
 * Протокол сообщений между extension host и webview.
 * Единственный файл, который импортируют обе стороны.
 */

/** Какие агенты доступны в переключателе. */
export type AgentId = "claude" | "codex";

/** Проект: папка, репозиторий, сервер (раздел 1 ai-dev-environment.md). */
export interface ProjectInfo {
  name: string;
  path: string;
  githubRepo?: string;
  /** Основная рабочая ветка git. */
  branch?: string;
  /** Хост или SSH-алиас сервера, например «1.2.3.4» или «proj1». */
  serverHost?: string;
  /** Протокол доступа: ssh (по умолчанию), sftp или ftp. */
  serverProtocol?: "ssh" | "sftp" | "ftp";
  /** Порт (пусто — стандартный: 22 для ssh/sftp, 21 для ftp). */
  serverPort?: number;
  /** Логин на сервере, например «deploy». */
  serverUser?: string;
  /** Свободные заметки о сервере: пути к логам, как деплоить и т.п. */
  server?: string;
}

/** Вложение к сообщению: файл или скриншот. */
export interface Attachment {
  name: string;
  path: string;
}

/** webview → extension */
export type WebviewToHost =
  | { type: "ready" }
  | {
      type: "send";
      text: string;
      agent: AgentId;
      attachments?: Attachment[];
      /** Проект, в котором выполнять ход (пусто — активный). Нужен очереди
       *  фонового проекта, чтобы не стрелять в активный. */
      path?: string;
    }
  | { type: "pickAttachment" }
  | { type: "saveAttachment"; name: string; dataBase64: string }
  | { type: "stop" }
  | { type: "newSession" }
  | { type: "finishSession"; agent: AgentId }
  | { type: "permission"; requestId: string; allow: boolean; answer?: string }
  | { type: "selectProject"; path: string }
  | { type: "addProject" }
  | { type: "showSessions" }
  | { type: "getSettings" }
  | { type: "exportSettings" }
  | { type: "importSettings" }
  | { type: "applyConfigJson"; json: string }
  | {
      type: "testServer";
      host: string;
      user?: string;
      password?: string;
      protocol?: "ssh" | "sftp" | "ftp";
      port?: number;
    }
  | { type: "saveSettings"; settings: SettingsSave }
  | { type: "cycleSafety"; agent: AgentId }
  | { type: "saveTranscript"; path: string; items: unknown[] };

/**
 * extension → webview.
 * `path` — проект-адресат события: ходы разных проектов идут параллельно,
 * и webview маршрутизирует события в ленту/статусы своего проекта.
 * Пустой path трактуется как «активный проект».
 */
export type HostToWebview =
  | { type: "busy"; value: boolean; path?: string }
  | { type: "activity"; label: string; path?: string }
  | { type: "sessionInfo"; sessionId: string | null; agent: AgentId; path?: string }
  | { type: "textDelta"; text: string; path?: string }
  | { type: "assistantText"; text: string; path?: string }
  | { type: "toolUse"; toolName: string; summary: string; path?: string }
  | {
      type: "turnResult";
      ok: boolean;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
      path?: string;
    }
  | { type: "info"; text: string; path?: string }
  | { type: "error"; message: string; path?: string }
  | { type: "reset"; path?: string }
  | {
      type: "permissionRequest";
      requestId: string;
      toolName: string;
      inputPreview: string;
      /** «tool» — подтверждение операции; «question» — агент задаёт вопрос. */
      kind: "tool" | "question";
      question?: string;
      options?: { label: string; description?: string }[];
      path?: string;
    }
  | { type: "permissionResolved"; requestId: string; allow: boolean; path?: string }
  | { type: "projects"; projects: ProjectInfo[]; activePath: string }
  | { type: "transcript"; path: string; items: unknown[] }
  | { type: "contextUsage"; agent: AgentId; used: number; max: number; path?: string }
  | { type: "modelInfo"; agent: AgentId; model: string; fallbackFrom?: string; path?: string }
  | { type: "settings"; settings: SettingsSnapshot }
  | { type: "safetyInfo"; agent: AgentId; label: string; dangerous: boolean }
  | { type: "attachmentAdded"; files: Attachment[] }
  | { type: "serverTestResult"; ok: boolean; message: string }
  | { type: "configJson"; json: string }
  | { type: "configJsonResult"; ok: boolean; message: string }
  | { type: "openSettingsScreen" };

/** Снимок всех настроек для экрана настроек внутри панели. */
export interface SettingsSnapshot {
  claude: {
    model: string;
    effort: string;
    permissionMode: string;
    maxTurns: number;
    contextWindow: number;
  };
  codex: {
    model: string;
    effort: string;
    sandbox: string;
    yolo: boolean;
    contextWindow: number;
  };
  journalDir: string;
  journalContextEntries: number;
  autoAllowTools: string[];
  autoAllowBash: string[];
  /** Активный проект (null — проектов нет). */
  project: ProjectInfo | null;
  projectHasPassword: boolean;
}

/** То же + пароль: undefined — не менять, "" — удалить, иначе — новый. */
export interface SettingsSave extends SettingsSnapshot {
  newPassword?: string;
}
