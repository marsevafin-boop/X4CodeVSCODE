/**
 * Протокол сообщений между extension host и webview.
 * Единственный файл, который импортируют обе стороны.
 */

/** Какие агенты доступны в переключателе. */
export type AgentId = "claude" | "codex";

/** Проект: папка, репозиторий, сервер (раздел 1 ai-dev-environment.md). */
export interface ProjectInfo {
  /** Stable profile identity; absent on legacy projects keyed by their folder. */
  id?: string;
  name: string;
  /** Real working directory; several profiles may use the same folder. */
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
  /** Original path/key remains unchanged while the files are kept here. */
  archive?: { path: string; archivedAt: number };
}

/** Вложение к сообщению: файл или скриншот. */
export interface Attachment {
  name: string;
  path: string;
}

/** Slash-команда CLI для меню автодополнения в композере. */
export interface SlashCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** webview → extension */
export type WebviewToHost =
  | { type: "ready"; chatId?: string }
  | { type: "openMultiChat" }
  | { type: "multiStateReady"; chatIds: string[] }
  | { type: "createChat"; projectPath?: string }
  | { type: "removeChat"; chatId: string }
  | { type: "selectChatProject"; chatId: string; projectPath: string }
  | { type: "selectChatSession"; chatId: string; recordId: string }
  | { type: "selectChatAgent"; chatId: string; agent: AgentId }
  | { type: "duplicateProject"; path: string; copyFolder: boolean }
  | { type: "archiveProject"; path: string }
  | { type: "restoreProject"; path: string }
  | { type: "showArchive" }
  | { type: "moveProject"; path: string; direction: "up" | "down" }
  | { type: "reorderProjects"; paths: string[] }
  | {
      type: "send";
      text: string;
      agent: AgentId;
      attachments?: Attachment[];
      /** Логический ключ проекта (id либо путь старой записи; пусто — активный).
       * Нужен очереди
       *  фонового проекта, чтобы не стрелять в активный. */
      path?: string;
      chatId?: string;
    }
  | {
      /** Докинуть сообщение в идущий ход (корректировка на лету). */
      type: "steer";
      text: string;
      /** now — немедленно, прервав шаг; next — на ближайшей границе шага. */
      mode: "now" | "next";
      agent: AgentId;
      attachments?: Attachment[];
      path?: string;
      chatId?: string;
    }
  | { type: "pickAttachment"; path?: string; chatId?: string }
  | {
      /** path — проект ленты, в чью папку сохранить (не «активный» хоста). */
      type: "saveAttachment";
      name: string;
      dataBase64: string;
      path?: string;
      chatId?: string;
    }
  | { type: "stop"; path?: string; chatId?: string }
  | { type: "newSession"; chatId?: string }
  | { type: "finishSession"; agent: AgentId; chatId?: string }
  | { type: "permission"; requestId: string; allow: boolean; answer?: string; chatId?: string }
  | { type: "selectProject"; path: string }
  | { type: "addProject" }
  | { type: "deleteProject"; path: string }
  | { type: "manageProjects"; chatId?: string }
  | { type: "showSessions"; chatId?: string }
  | { type: "openFullView" }
  | { type: "getSettings"; chatId?: string }
  | { type: "exportSettings" }
  | { type: "importSettings" }
  | { type: "applyConfigJson"; json: string }
  | {
      type: "testServer";
      /** Logical profile key, despite the legacy field name. */
      projectPath: string;
      requestId: string;
      host: string;
      user?: string;
      password?: string;
      protocol?: "ssh" | "sftp" | "ftp";
      port?: number;
    }
  | { type: "saveSettings"; settings: SettingsSave; chatId?: string }
  | { type: "cycleSafety"; agent: AgentId }
  | { type: "pickModel"; agent: AgentId; chatId?: string }
  | { type: "pickEffort"; agent: AgentId; chatId?: string }
  | { type: "showContext"; agent: AgentId; chatId?: string }
  | {
      /** Выбор из меню мобильного клиента (вместо QuickPick VS Code). */
      type: "choose";
      kind: "model" | "effort" | "session";
      agent?: AgentId;
      value: string;
      scope?: "chat" | "base";
      chatId?: string;
    }
  | { type: "manageSecretEnv"; chatId?: string }
  | {
      /** Текст сообщения с доступами (KEY=value построчно) — сохранить в env
       *  выбранных проектов, агенту НЕ отправлять. path — проект ленты. */
      type: "sendSecretEnv";
      text: string;
      path?: string;
      chatId?: string;
    }
  | {
      /** Клик по плашке файла в ленте: открыть файл в редакторе.
       *  project — путь проекта ленты для резолва относительных путей. */
      type: "openFile";
      path: string;
      project?: string;
    }
  | { type: "saveTranscript"; path: string; items: unknown[]; chatId?: string; recordId?: string };

/**
 * extension → webview.
 * `path` — логический ключ проекта (id либо путь старого проекта), не cwd.
 * Ходы разных проектов идут параллельно,
 * и webview маршрутизирует события в ленту/статусы своего проекта.
 * Пустой path трактуется как «активный проект».
 */
export type HostToWebview =
  | { type: "chatProjectRejected"; chatId: string; requestedProjectPath: string; projectPath: string; recordId: string; agent: AgentId; message: string }
  | { type: "busy"; value: boolean; path?: string; chatId?: string }
  | { type: "activity"; label: string; path?: string; chatId?: string }
  | { type: "sessionInfo"; sessionId: string | null; agent: AgentId; path?: string; chatId?: string }
  | {
      /** Эхо сообщения пользователя: пузырь создаёт хост, чтобы обе
       *  поверхности (сайдбар и вкладка) имели одинаковую ленту. */
      type: "userMessage";
      text: string;
      attachments?: string[];
      path?: string;
      chatId?: string;
    }
  | { type: "textDelta"; text: string; path?: string; chatId?: string }
  | { type: "assistantText"; text: string; path?: string; chatId?: string }
  | { type: "toolUse"; toolName: string; summary: string; path?: string; chatId?: string }
  | {
      type: "turnResult";
      ok: boolean;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
      path?: string;
      chatId?: string;
    }
  | { type: "info"; text: string; path?: string; chatId?: string }
  | { type: "error"; message: string; path?: string; chatId?: string }
  | { type: "reset"; path?: string; chatId?: string }
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
      chatId?: string;
    }
  | { type: "permissionResolved"; requestId: string; allow: boolean; path?: string; chatId?: string }
  | { type: "projects"; projects: ProjectInfo[]; archivedProjects?: ProjectInfo[]; activePath: string; chatId?: string }
  | { type: "transcript"; path: string; items: unknown[]; chatId?: string; recordId?: string }
  | { type: "multiState"; boardId?: string; projects: ProjectInfo[]; archivedProjects?: ProjectInfo[]; chats: { chatId: string; projectPath: string; recordId: string; agent: AgentId; title: string }[] }
  | { type: "contextUsage"; agent: AgentId; used: number; max: number; path?: string; chatId?: string }
  | { type: "modelInfo"; agent: AgentId; model: string; fallbackFrom?: string; path?: string; chatId?: string }
  | { type: "slashCommands"; agent: AgentId; commands: SlashCommandInfo[] }
  | { type: "settings"; settings: SettingsSnapshot; chatId?: string }
  | { type: "safetyInfo"; agent: AgentId; label: string; dangerous: boolean }
  | { type: "effortInfo"; agent: AgentId; effort: string }
  | { type: "autoScrollMode"; mode: string }
  | {
      /** Меню выбора для мобильного клиента (модель / effort / сессия). */
      type: "choices";
      kind: "model" | "effort" | "session";
      agent?: AgentId;
      title: string;
      items: { label: string; detail?: string; value: string; current?: boolean }[];
    }
  | {
      /** Черновик обработан хостом (доступы сохранены) — очистить поле ввода. */
      type: "draftHandled";
      path?: string;
    }
  | { type: "attachmentAdded"; files: Attachment[]; path?: string }
  | { type: "serverTestResult"; projectPath: string; requestId: string; ok: boolean; message: string }
  | { type: "configJson"; json: string; chatId?: string }
  | { type: "configJsonResult"; ok: boolean; message: string }
  | { type: "openSettingsScreen"; chatId?: string };

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
  /** Автокоммит всех изменений в папке проекта после каждого хода агента. */
  autoCommit: boolean;
  /** После автокоммита сразу пушить в origin. */
  autoPush: boolean;
  /** Перед каждым ходом подтягивать новые коммиты из origin. */
  autoPull: boolean;
  /** Автопрокрутка чата: perProject (галочка у каждого проекта) | allOn | allOff. */
  autoScrollMode: string;
  /** Активный проект (null — проектов нет). */
  project: ProjectInfo | null;
  projectHasPassword: boolean;
  /** Имена секретных переменных окружения проекта (значения — в Keychain). */
  secretEnvNames: string[];
}

/** То же + пароль: undefined — не менять, "" — удалить, иначе — новый. */
export interface SettingsSave extends SettingsSnapshot {
  newPassword?: string;
}
