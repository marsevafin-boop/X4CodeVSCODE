import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import type {
  AgentId,
  Attachment,
  HostToWebview,
  ProjectInfo,
  SlashCommandInfo,
  WebviewToHost,
} from "./shared/protocol";
import type { AgentBackend, SteerChannel } from "./agents/types";
import { ClaudeBackend } from "./agents/claudeBackend";
import { CodexBackend, codexDefaultModel, killAllCodex } from "./agents/codexBackend";
import { CodexAppServerBackend } from "./agents/codexAppServerBackend";
import { CodexWriterRecoveryBackend } from "./agents/codexWriterRecovery";
import { buildFinishPrompt, readJournalContext } from "./journal";
import { buildServerEnvironment, formatSshCommand, testServerConnection } from "./serverConnection";
import { isProjectId, projectKey } from "./shared/projectIdentity";
import { directoriesOverlap, executeProjectMove, normalizeProjectArchive, pathEntryExists, planProjectMove, type ProjectMovePlan } from "./projectArchive";
import { applyActiveProjectOrder, moveInProjectOrder, reconcileProjectOrder } from "./shared/projectOrder";
import * as QRCode from "qrcode";
import {
  RemoteServer,
  enableTailscaleFunnel,
  generateToken,
  lanAddresses,
  tailscaleInfo,
  type RemoteClient,
} from "./remoteServer";

const LEGACY_SESSIONS_KEY = "agentHub.sessions";
const LEGACY_TRANSCRIPTS_KEY = "agentHub.transcripts";
const STORE_KEY = "agentHub.sessionStore";
const MULTI_CHATS_KEY = "agentHub.multiChats";
const MULTI_BOARD_KEY_PREFIX = "agentHub.multiBoard.";
const MULTI_BOARD_LAYOUT_KEY_PREFIX = "agentHub.multiBoardLayout.";
const PROJECT_ORDER_KEY = "agentHub.projectOrder";
const PROJECT_MOVE_KEY = "agentHub.pendingProjectMove";
interface PendingProjectMove { plan: ProjectMovePlan; keys: string[]; nextProjects: ProjectInfo[]; }
const MULTI_PREFERRED_AGENT_KEY = "agentHub.multiPreferredAgent";
const ACTIVE_PROJECT_KEY = "agentHub.activeProject";
const CLAUDE_COMMANDS_KEY = "agentHub.claudeCommands";
const CLAUDE_MODELS_KEY = "agentHub.claudeModels";
const CLAUDE_MODELS_AT_KEY = "agentHub.claudeModelsAt";
/** Список моделей Claude перезапрашивается у CLI не реже раза в 6 часов. */
const CLAUDE_MODELS_TTL_MS = 6 * 60 * 60 * 1000;
const REMOTE_TOKEN_KEY = "agentHub.remoteToken";
/** Действия с нативными диалогами VS Code — мобильному клиенту недоступны. */
const VSCODE_ONLY_ACTIONS = new Set<string>([
  "addProject",
  "deleteProject",
  "archiveProject",
  "restoreProject",
  "showArchive",
  "moveProject",
  "reorderProjects",
  "manageProjects",
  "manageSecretEnv",
  "showContext",
  "exportSettings",
  "importSettings",
  "applyConfigJson",
  "openFullView",
  "openMultiChat",
  "duplicateProject",
  "pickAttachment",
  "sendSecretEnv",
]);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function expandProjectPath(path: string): string {
  return path.replace(/^~(?=\/|$)/, os.homedir());
}

function configuredProjectKey(project: ProjectInfo): string {
  return projectKey({ ...project, path: expandProjectPath(project.path) });
}

/** Symlink aliases share the same writer/Git exclusion boundary. */
function physicalDirectory(path: string): string {
  let current = nodePath.resolve(path);
  const missing: string[] = [];
  while (true) {
    try { return nodePath.join(fs.realpathSync(current), ...missing); } catch {
      const parent = nodePath.dirname(current);
      if (parent === current) return nodePath.resolve(path);
      missing.unshift(nodePath.basename(current));
      current = parent;
    }
  }
}
/** Модель Claude из supportedModels SDK (кэш в globalState). */
interface ClaudeModelInfo {
  value: string;
  displayName?: string;
  description?: string;
  supportedEffortLevels?: string[];
}

/** Папки workspace, которые пользователь убрал из списка проектов. */
const HIDDEN_PROJECTS_KEY = "agentHub.hiddenProjects";
const TRANSCRIPT_MAX_ITEMS = 300;
const MAX_SESSIONS_PER_PROJECT = 30;

/** Общий лог беседы: лимиты хранения и вставки в промпт другого агента.
 *  Вставка отбирает самые свежие записи; то, что не влезло в лимит,
 *  сознательно отбрасывается (как при компакшне) — заголовок блока
 *  сообщает агенту, что показан только хвост беседы. */
const CHAT_LOG_MAX_ENTRIES = 200;
const CHAT_LOG_ENTRY_MAX = 6000;
const CROSS_INJECT_ENTRY_MAX = 4000;
const CROSS_INJECT_TOTAL_MAX = 60000;

type ProjectSessions = Record<AgentId, string | null>;

/** Запись общего лога беседы — зеркало видимой ленты для передачи контекста между агентами. */
interface ChatLogEntry {
  agent: AgentId;
  role: "user" | "assistant";
  text: string;
}

/** Одна сессия в истории проекта. */
interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** resume id каждого агента внутри этой сессии. */
  agentIds: ProjectSessions;
  /** Сохранённая лента чата (элементы webview). */
  items: unknown[];
  /** Общий лог беседы: лента одна, а CLI-сессии агентов раздельные. */
  chatLog?: ChatLogEntry[];
  /** До какого индекса chatLog каждый агент видел ленту в своей CLI-сессии. */
  chatSeen?: Partial<Record<AgentId, number>>;
  /** Точный промпт последнего хода по агентам — для просмотрщика контекста. */
  lastPrompts?: Partial<Record<AgentId, string>>;
  /** Модель, выбранная ТОЛЬКО для этого чата (пусто — базовая из настроек). */
  modelOverrides?: Partial<Record<AgentId, string>>;
  /** Последняя известная занятость контекста по агентам. */
  context?: Partial<Record<AgentId, { used: number; max: number }>>;
  /** Последняя известная модель по агентам. */
  models?: Partial<Record<AgentId, string>>;
  /** Если модель понижена фоллбэком — с какой (по агентам). */
  modelFallbacks?: Partial<Record<AgentId, string>>;
}

interface ProjectStore {
  activeId: string | null;
  sessions: SessionRecord[];
}

interface ChatSlot {
  chatId: string;
  projectPath: string;
  recordId: string;
  agent: AgentId;
}

interface DirectoryRunGroup {
  controllers: Set<AbortController>;
  overlapped: boolean;
  gitOperation?: Promise<void>;
}

/** Стартовый список команд Claude до первого хода — реальный приходит из CLI. */
const DEFAULT_CLAUDE_COMMANDS: SlashCommandInfo[] = [
  { name: "compact", description: "Сжать контекст сессии (compaction)" },
  { name: "review", description: "Код-ревью текущих изменений" },
  { name: "init", description: "Создать/обновить CLAUDE.md проекта" },
  { name: "usage", description: "Использование лимитов подписки" },
];

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function isImagePath(p: string): boolean {
  return IMAGE_EXT.has(nodePath.extname(p).toLowerCase());
}

/** Блок «Приложенные файлы» перед текстом пользователя. */
function buildAttachmentsBlock(attachments: Attachment[]): string {
  const lines = attachments.map(
    (a) => `- ${a.path}${isImagePath(a.path) ? " (изображение — открой и рассмотри)" : ""}`,
  );
  return `Приложенные файлы:\n${lines.join("\n")}`;
}

/** Обрезка текста для хранения в общем логе беседы. */
function clipLog(text: string): string {
  return text.length > CHAT_LOG_ENTRY_MAX
    ? text.slice(0, CHAT_LOG_ENTRY_MAX) + "\n…[обрезано]"
    : text;
}

/**
 * Блок контекста для агента, не видевшего часть общей ленты: лента чата одна,
 * а CLI-сессии Claude и Codex раздельные — при переключении агенту передаём
 * текстом сообщения, которые обрабатывал другой агент.
 */
function buildCrossContext(entries: ChatLogEntry[]): { block: string; count: number } | null {
  if (entries.length === 0) return null;
  const picked: string[] = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const name = e.agent === "claude" ? "Claude" : "Codex";
    const who = e.role === "user" ? `Пользователь (агенту ${name})` : `Агент ${name}`;
    const text =
      e.text.length > CROSS_INJECT_ENTRY_MAX
        ? e.text.slice(0, CROSS_INJECT_ENTRY_MAX) + "\n…[обрезано]"
        : e.text;
    const piece = `${who}:\n${text}`;
    if (picked.length > 0 && total + piece.length > CROSS_INJECT_TOTAL_MAX) break;
    picked.unshift(piece);
    total += piece.length;
  }
  const note =
    picked.length < entries.length
      ? ` (показаны последние ${picked.length} из ${entries.length})`
      : "";
  const block =
    `Контекст беседы: этот чат общий для двух агентов — Claude и Codex. ` +
    `Ниже — сообщения этой же беседы, которые обрабатывал другой агент; ты их ещё не видел${note}:\n\n` +
    picked.join("\n\n---\n\n") +
    `\n\nЭто часть текущей беседы с пользователем: учитывай её и продолжай с места, где беседа остановилась.`;
  return { block, count: picked.length };
}

/** Валидация и нормализация списка проектов из внешнего JSON. */
function normalizeProjects(raw: unknown[]): ProjectInfo[] {
  const out: ProjectInfo[] = [];
  for (const item of raw) {
    const p = item as Partial<ProjectInfo>;
    if (!p || typeof p.path !== "string" || !p.path.trim()) continue;
    const proto = p.serverProtocol;
    const port =
      typeof p.serverPort === "number" && p.serverPort >= 1 && p.serverPort <= 65535
        ? p.serverPort
        : undefined;
    out.push({
      ...(isProjectId(p.id) ? { id: p.id } : {}),
      name: typeof p.name === "string" && p.name ? p.name : nodePath.basename(p.path),
      path: p.path,
      ...(normalizeProjectArchive(expandProjectPath(p.path), p.archive) ? { archive: normalizeProjectArchive(expandProjectPath(p.path), p.archive) } : {}),
      ...(typeof p.githubRepo === "string" && p.githubRepo ? { githubRepo: p.githubRepo } : {}),
      ...(typeof p.branch === "string" && p.branch ? { branch: p.branch } : {}),
      ...(typeof p.serverHost === "string" && p.serverHost ? { serverHost: p.serverHost } : {}),
      ...(proto === "ssh" || proto === "sftp" || proto === "ftp" ? { serverProtocol: proto } : {}),
      ...(port ? { serverPort: port } : {}),
      ...(typeof p.serverUser === "string" && p.serverUser ? { serverUser: p.serverUser } : {}),
      ...(typeof p.server === "string" && p.server ? { server: p.server } : {}),
    });
  }
  return out;
}

/** Сессия «непустая», только если пользователь что-то написал (служебные строки не в счёт). */
function hasUserContent(items: unknown[]): boolean {
  return items.some((it) => (it as { role?: string })?.role === "user");
}

/** Заголовок сессии — из первого сообщения пользователя. */
function deriveTitle(items: unknown[]): string | null {
  for (const it of items) {
    const o = it as { role?: string; text?: string };
    if (o?.role === "user" && typeof o.text === "string" && o.text.trim()) {
      const t = o.text.trim().replace(/\s+/g, " ");
      return t.length > 48 ? t.slice(0, 48) + "…" : t;
    }
  }
  return null;
}

/** Компактное человекочитаемое представление входа инструмента для карточки. */
function formatInputPreview(input: unknown): string {
  if (typeof input !== "object" || input === null) return String(input ?? "");
  const obj = input as Record<string, unknown>;
  // Для Bash показываем команду как есть — это главное, что оценивает человек.
  if (typeof obj.command === "string") {
    const extra = typeof obj.description === "string" ? `\n# ${obj.description}` : "";
    return obj.command + extra;
  }
  const json = JSON.stringify(obj, null, 2);
  return json.length > 1500 ? json.slice(0, 1500) + "\n…" : json;
}

interface QuestionOrigin {
  chatId: string;
  recordId: string;
  createdAt: number;
  sessionId: string | null;
}

interface DeferredTurn {
  prompt: string;
  agent: AgentId;
  chatId?: string;
  questionOrigin?: QuestionOrigin;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "agentHub.chat";
  static readonly multiViewId = "agentHub.multiChat";

  private view?: vscode.WebviewView;
  /** Полноэкранный режим: тот же чат вкладкой редактора; работает синхронно с сайдбаром. */
  private panel: vscode.WebviewPanel | null = null;
  /** One optional grid panel; legacy sidebar/panel/remote remain single-chat. */
  private multiPanel: vscode.WebviewPanel | null = null;
  private multiInit?: Promise<void>;
  /** A board belongs to this extension host; another window's persistence cannot replace it. */
  private chatSlots?: ChatSlot[];
  private multiLayoutInitialized = false;
  private multiLayoutNeedsMigration = false;
  private multiLayoutPinned = false;
  private multiBoardId?: string;
  private multiMutation?: Promise<void>;
  private readonly backends: Record<AgentId, AgentBackend> = {
    claude: new ClaudeBackend(),
    // app-server: корректировка на лету, стриминг, синхронные вопросы.
    codex: new CodexAppServerBackend(),
  };
  /** Запасной транспорт Codex (настройка agentHub.codex.transport = exec). */
  private readonly codexExec = new CodexWriterRecoveryBackend(new CodexBackend(), this.backends.codex);
  /** Live state is keyed by chat identity (legacy surfaces use project keys). */
  private steers = new Map<string, SteerChannel>();
  /** Тексты, докинутые в текущий ход, — для общего лога беседы. */
  private steerTexts = new Map<string, string[]>();
  /** Запущенные ходы: логический ключ профиля → контроллер. */
  private runs = new Map<string, AbortController>();
  /** Shared cwd runs are permitted; overlap disables unsafe pull/auto-Git. */
  private directoryRuns = new Map<string, DirectoryRunGroup>();
  private sessionWriters = new Map<string, AbortController>();
  /** Long copies run outside the mutation queue, but their directories cannot be moved. */
  private folderCopyReservations = new Set<string>();
  /** Сообщения для транспорта без живого канала; вопросы привязаны к сессии. */
  private deferred = new Map<string, DeferredTurn[]>();
  /** Сервер мобильного доступа (третья поверхность рядом с сайдбаром и панелью). */
  private remote: RemoteServer | null = null;
  /** Включён на эту сессию, когда настройку сохранить нельзя (окно не перезагружено). */
  private remoteForced = false;
  /** Ожидающие решения запросы canUseTool: requestId → {проект, resolve}. */
  private pendingPermissions = new Map<
    string,
    { path: string; chatId?: string; recordId?: string; resolve: (result: { allow: boolean; answer?: string }) => void | Promise<void> }
  >();

  /** Сообщение с меткой проекта — webview маршрутизирует в свою ленту. */
  private postScoped(path: string, msg: HostToWebview, chatId?: string) {
    const event = { ...msg, path, ...(chatId ? { chatId } : {}) } as HostToWebview;
    if (chatId) this.multiPanel?.webview.postMessage(event);
    else this.post(event);
  }

  /** После изменения реестра: остановить ходы проектов, которых больше нет. */
  private abortOrphanRuns() {
    const known = new Set(this.getProjects().map(projectKey));
    const liveChats = new Set(this.getChatSlots().map((slot) => slot.chatId));
    for (const [path, controller] of [...this.runs]) {
      if (path.startsWith("chat-") ? !liveChats.has(path) : !known.has(path)) {
        controller.abort();
        this.denyAllPending(path.startsWith("chat-") ? undefined : path, path.startsWith("chat-") ? path : undefined);
      }
    }
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    void this.serializeMultiMutation(() => this.recoverPendingProjectMove());
    void this.syncRemoteServer();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("agentHub.remote")) void this.syncRemoteServer();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    view.webview.html = this.renderHtml(view.webview, "view");
    view.webview.onDidReceiveMessage((msg: WebviewToHost) =>
      this.onMessage(msg, "vscode", undefined, "view"),
    );
  }

  // ---------- Проекты ----------

  /** Complete registry including archives; stable keys and original paths never change. */
  private getAllProjects(): ProjectInfo[] {
    const cfg = vscode.workspace.getConfiguration("agentHub");
    const configured = cfg.get<ProjectInfo[]>("projects", []) ?? [];
    const projects: ProjectInfo[] = [];
    const seen = new Set<string>();
    const configuredFolders = new Set<string>();

    for (const p of configured) {
      if (!p || typeof p.path !== "string" || !p.path) continue;
      const path = expandProjectPath(p.path);
      const identity = configuredProjectKey(p);
      if (seen.has(identity)) continue;
      seen.add(identity);
      configuredFolders.add(physicalDirectory(path));
      const archive = normalizeProjectArchive(path, p.archive);
      if (archive) configuredFolders.add(physicalDirectory(archive.path));
      projects.push({
        ...(isProjectId(p.id) ? { id: p.id } : {}),
        name: p.name || nodePath.basename(path),
        path,
        ...(archive ? { archive } : {}),
        githubRepo: p.githubRepo,
        branch: p.branch,
        serverHost: p.serverHost,
        serverProtocol: p.serverProtocol,
        serverPort: p.serverPort,
        serverUser: p.serverUser,
        server: p.server,
      });
    }

    // Папки workspace — автоматически, кроме тех, что пользователь убрал.
    const hidden = new Set(this.context.globalState.get<string[]>(HIDDEN_PROJECTS_KEY, []));
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const path = folder.uri.fsPath;
      if (!configuredFolders.has(physicalDirectory(path)) && !seen.has(path) && !hidden.has(path)) {
        seen.add(path);
        projects.push({ name: folder.name, path });
      }
    }
    const order = reconcileProjectOrder(projects.map(projectKey), this.context.globalState.get<string[]>(PROJECT_ORDER_KEY, []));
    const byKey = new Map(projects.map((project) => [projectKey(project), project]));
    return order.map((key) => byKey.get(key)!);
  }

  private getProjects(): ProjectInfo[] {
    return this.getAllProjects().filter((project) => !project.archive);
  }

  private getArchivedProjects(): ProjectInfo[] {
    return this.getAllProjects().filter((project) => !!project.archive);
  }

  private async setProjectHidden(path: string, hidden: boolean) {
    const list = this.context.globalState.get<string[]>(HIDDEN_PROJECTS_KEY, []);
    const next = hidden ? [...new Set([...list, path])] : list.filter((p) => p !== path);
    await this.context.globalState.update(HIDDEN_PROJECTS_KEY, next);
  }

  /**
   * Список всех проектов: переключиться (выбор строки), удалить любой
   * (корзинка у строки — без переключения на него), добавить новый.
   */
  async manageProjects(chatId?: string) {
    if (chatId && !this.findChatSlot(chatId)) return;
    type Item = vscode.QuickPickItem & { path?: string; add?: boolean; archiveList?: boolean };
    const archiveButton = { iconPath: new vscode.ThemeIcon("archive"), tooltip: "Архивировать проект вместе с папкой…" };
    const deleteButton = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Удалить проект…" };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = "Проекты Agent Hub";
    qp.placeholder = "Выберите проект; кнопки у строки — архивировать или удалить";
    qp.ignoreFocusOut = true;

    const toItems = (): Item[] => {
      const slot = this.findChatSlot(chatId);
      const active = chatId
        ? this.getProjects().find((entry) => projectKey(entry) === slot?.projectPath)
        : this.getActiveProject();
      const items: Item[] = this.getProjects().map((p) => ({
        label: (projectKey(p) === (active ? projectKey(active) : undefined) ? "$(circle-filled) " : "$(folder) ") + p.name,
        description: p.path,
        detail:
          [
            p.githubRepo,
            p.serverHost && `сервер: ${p.serverHost}`,
            this.runs.has(projectKey(p)) && "⏳ идёт ход",
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
        path: projectKey(p),
        buttons: [archiveButton, deleteButton],
      }));
      items.push({ label: "$(add) Добавить проект…", add: true });
      items.push({ label: `$(archive) Архив проектов (${this.getArchivedProjects().length})…`, archiveList: true });
      return items;
    };
    qp.items = toItems();

    // Модальное подтверждение удаления может скрыть список — не уничтожаем
    // его, пока идёт удаление, и показываем снова.
    let deleting = false;
    qp.onDidTriggerItemButton(async (e) => {
      if (!e.item.path) return;
      deleting = true;
      try {
        if (e.button === archiveButton) await this.archiveProject(e.item.path);
        else if (e.button === deleteButton) await this.deleteProject(e.item.path);
      } finally {
        deleting = false;
      }
      qp.items = toItems();
      qp.show();
    });

    qp.onDidAccept(async () => {
      const picked = qp.selectedItems[0];
      qp.hide();
      if (!picked) return;
      if (picked.archiveList) {
        await this.showArchive();
        return;
      }
      if (picked.add) {
        await this.addProject();
        return;
      }
      if (picked.path) {
        if (chatId) {
          await this.serializeMultiMutation(() => this.selectMultiChatProject(chatId, picked.path!));
        } else {
          await this.serializeMultiMutation(async () => {
            if (!this.getProjects().some((entry) => projectKey(entry) === picked.path)) return;
            await this.setActivePath(picked.path);
            this.postFullState();
          });
        }
      }
    });

    qp.onDidHide(() => {
      if (!deleting) qp.dispose();
    });
    qp.show();
  }

  /** Удаление активного проекта — для команды палитры и кнопки панели. */
  async deleteActiveProject() {
    const active = this.getActiveProject();
    if (!active) {
      void vscode.window.showWarningMessage("Нет проектов — удалять нечего.");
      return;
    }
    await this.deleteProject(projectKey(active));
  }

  /**
   * Просмотрщик контекста: что агент получит из базы проекта со следующим
   * сообщением (карточка, журнал, лента другого агента) и точный промпт
   * последнего хода. Открывается отдельным markdown-документом.
   */
  async showContext(agent: AgentId, chatId?: string) {
    const slot = this.findChatSlot(chatId);
    const project = slot
      ? this.getProjects().find((entry) => projectKey(entry) === slot.projectPath)
      : this.getActiveProject();
    if (!project) {
      void vscode.window.showWarningMessage("Нет проектов — контекст показывать не для чего.");
      return;
    }
    const cfg = vscode.workspace.getConfiguration("agentHub");
    const record = slot
      ? this.getProjectStore(slot.projectPath).sessions.find((entry) => entry.id === slot.recordId) ?? null
      : this.getActiveRecord(projectKey(project));
    const agentName = agent === "claude" ? "Claude" : "GPT (Codex)";
    const sessionId = record?.agentIds[agent] ?? null;
    const journalDir = cfg.get<string>("journalDir", "docs/journal");

    const parts: string[] = [
      `# 🧠 Контекст агента ${agentName} — проект «${project.name}»`,
      "",
      sessionId
        ? "CLI-сессия продолжается (resume id: " + "`" + sessionId + "`" + "). Внутри неё агент помнит все предыдущие сообщения ЭТОЙ сессии, свой системный промпт и результаты инструментов — они хранятся на стороне CLI и в файл не входят."
        : "CLI-сессии ещё нет: следующее сообщение начнёт новую — к нему добавятся карточка проекта и журнал (ниже).",
      "",
      "## Что будет добавлено к следующему сообщению",
    ];

    if (!sessionId) {
      parts.push("", "### Карточка проекта", "", "```", await this.buildProjectCard(project), "```");
      const journal = await readJournalContext(
        project.path,
        journalDir,
        cfg.get<number>("journalContextEntries", 3),
      );
      parts.push(
        "",
        "### Журнал сессий (общая память)",
        "",
        journal
          ? "```\n" + journal + "\n```"
          : `_Журнала нет — папка ${journalDir} пуста или отсутствует._`,
      );
    }

    const chatLog = record?.chatLog ?? [];
    const seenIdx = Math.min(record?.chatSeen?.[agent] ?? 0, chatLog.length);
    const unseen = chatLog.slice(seenIdx).filter((e) => e.agent !== agent);
    const cross = buildCrossContext(unseen);
    parts.push(
      "",
      "### Сообщения другого агента из этой ленты",
      "",
      cross
        ? "Непросмотренных: " + String(cross.count) + ".\n\n" + "```\n" + cross.block + "\n```"
        : "_Нет: агент видел всю ленту, либо второй агент в беседе не участвовал._",
    );
    if (sessionId && !cross) {
      parts.push(
        "",
        "_Итого: со следующим сообщением дополнительно ничего не уйдёт — только ваш текст (и блок путей вложений, если приложите файлы)._",
      );
    }

    const last = record?.lastPrompts?.[agent];
    parts.push(
      "",
      "## Точный промпт последнего хода (что реально ушло агенту)",
      "",
      last
        ? "```\n" + last + "\n```"
        : "_В этой сессии агент ещё не получал сообщений (или последний ход был до обновления)._",
    );

    const doc = await vscode.workspace.openTextDocument({
      content: parts.join("\n"),
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /**
   * Активный проект — per-окно (workspaceState): у каждого окна VS Code свой.
   * Раньше он лежал в globalState, а тот ОБЩИЙ для всех окон — окна с разными
   * проектами перезаписывали выбор друг друга, и форма настроек показывала
   * чужой проект. Старое глобальное значение оставлено как фолбэк-миграция.
   */
  private getActivePathRaw(): string | undefined {
    return (
      this.context.workspaceState.get<string>(ACTIVE_PROJECT_KEY) ??
      this.context.globalState.get<string>(ACTIVE_PROJECT_KEY)
    );
  }

  private async setActivePath(path: string | undefined) {
    await this.context.workspaceState.update(ACTIVE_PROJECT_KEY, path);
  }

  private getActiveProject(): ProjectInfo | null {
    const projects = this.getProjects();
    const saved = this.getActivePathRaw();
    return projects.find((p) => projectKey(p) === saved) ?? projects[0] ?? null;
  }

  private getActiveProjectKey(): string | undefined {
    const project = this.getActiveProject();
    return project ? projectKey(project) : undefined;
  }

  /** Ключ пароля сервера в SecretStorage (системный Keychain). */
  private passwordKey(projectPath: string): string {
    return `agentHub.serverPassword:${projectPath}`;
  }

  /** Ключ секретных переменных окружения проекта (JSON-объект в Keychain). */
  private secretEnvKey(projectPath: string): string {
    return `agentHub.secretEnv:${projectPath}`;
  }

  /** Секретные переменные окружения проекта: {ИМЯ: значение}. */
  private async getSecretEnv(projectPath: string): Promise<Record<string, string>> {
    try {
      const raw = await this.context.secrets.get(this.secretEnvKey(projectPath));
      const obj = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      return typeof obj === "object" && obj !== null ? obj : {};
    } catch {
      return {};
    }
  }

  /**
   * Добавление проекта: единственный нативный шаг — выбор папки. Запись
   * создаётся сразу, дальше все поля заполняются в форме настроек панели —
   * она не сбрасывается при переключении окон.
   */
  async addProject() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Выбрать папку проекта",
    });
    if (!picked?.[0]) return;
    try {
      await this.serializeMultiMutation(() => this.addPickedProject(picked[0].fsPath));
    } catch (error) {
      void vscode.window.showErrorMessage(`Не удалось добавить проект: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async addPickedProject(path: string) {
    if (this.getArchivedProjects().some((entry) => physicalDirectory(entry.path) === physicalDirectory(path) ||
        directoriesOverlap(entry.archive!.path, physicalDirectory(path)))) {
      throw new Error("Эта папка находится в архиве. Сначала восстановите проект из архива.");
    }
    if (!fs.existsSync(path) || !fs.statSync(path).isDirectory()) throw new Error("Выбранная папка больше недоступна. Откройте выбор папки заново.");
    const projects = this.getProjects();
    // Явно добавленная папка workspace больше не считается скрытой.
    await this.setProjectHidden(path, false);

    const cfg = vscode.workspace.getConfiguration("agentHub");
    const list = [...(cfg.get<ProjectInfo[]>("projects", []) ?? [])];
    // Preserve an implicit workspace row under its legacy path key before a
    // configured profile hides the automatic workspace fallback.
    for (const existing of projects) {
      if (physicalDirectory(existing.path) === physicalDirectory(path) &&
          !list.some((p) => configuredProjectKey(p) === projectKey(existing))) {
        list.push(existing);
      }
    }
    const names = new Set(projects.map((p) => p.name));
    const baseName = nodePath.basename(path);
    let name = baseName;
    for (let suffix = 2; names.has(name); suffix++) name = `${baseName} (${suffix})`;
    const fresh: ProjectInfo = { id: `project-${randomUUID()}`, name, path };
    list.push(fresh);
    await cfg.update("projects", list, vscode.ConfigurationTarget.Global);
    await this.setActivePath(projectKey(fresh));
    this.postFullState();
    await this.postSettings();
    // Открываем экран настроек панели: название, GitHub, ветка, сервер,
    // пароль — всё заполняется там, без риска потерять ввод.
    this.post({ type: "openSettingsScreen" });
    this.post({
      type: "info",
      text: `Проект «${name}» добавлен и выбран. Заполните детали в настройках (⚙) и нажмите «Сохранить».`,
    });
  }

  /** Clone a profile, optionally copying its complete folder to a sibling. */
  async duplicateProject(path: string, copyFolder: boolean) {
    const source = this.getProjects().find((entry) => projectKey(entry) === path);
    if (!source) return;
    const mode = copyFolder ? "папку и профиль" : "профиль в той же папке";
    const confirmed = await vscode.window.showWarningMessage(
      `Создать ${mode} «${source.name}»?`,
      { modal: true, detail: copyFolder
        ? `Будет рекурсивно скопирована вся папка в соседнюю «${nodePath.basename(source.path)} (копия)». Пароль SSH и переменные окружения проекта также будут скопированы в отдельные записи хранилища.`
        : "Новая запись будет использовать ту же папку, но получит собственную историю и отдельные копии пароля SSH и переменных окружения." },
      "Создать копию",
    );
    if (confirmed !== "Создать копию") return;

    let targetPath = source.path;
    let copiedFolder = false;
    let targetKey: string | undefined;
    let profilePersisted = false;
    let reserved: string[] = [];
    try {
      const prepared = await this.serializeMultiMutation(async () => {
        const current = this.getProjects().find((entry) => projectKey(entry) === path);
        if (!current || current.path !== source.path) throw new Error("Исходный проект удалён, архивирован или перемещён. Повторите создание копии.");
        if (this.context.globalState.get(PROJECT_MOVE_KEY)) throw new Error("Сначала завершите восстановление незавершённого перемещения проекта.");
        if (!fs.existsSync(current.path) || !fs.statSync(current.path).isDirectory()) throw new Error("Исходная папка недоступна.");
        if (copyFolder) {
          const parent = nodePath.dirname(current.path);
          const base = nodePath.basename(current.path);
          const reservations = this.folderCopyReservations ??= new Set();
          for (let suffix = 1; ; suffix++) {
            const candidate = nodePath.join(parent, suffix === 1 ? `${base} (копия)` : `${base} (копия ${suffix})`);
            if (!await pathEntryExists(candidate) && !reservations.has(physicalDirectory(candidate))) { targetPath = candidate; break; }
          }
          const candidates = [physicalDirectory(current.path), physicalDirectory(targetPath)];
          // Release only reservations acquired by this copy, never another copy's source.
          if (candidates.some((directory) => reservations.has(directory))) throw new Error("Эта папка уже копируется. Дождитесь завершения копирования.");
          for (const directory of candidates) reservations.add(directory);
          reserved = candidates;
        }
        return current;
      });
      if (copyFolder) {
        await fs.promises.cp(prepared.path, targetPath, { recursive: true, force: false, errorOnExist: true });
        copiedFolder = true;
      }
      await this.serializeMultiMutation(async () => {
        const current = this.getProjects().find((entry) => projectKey(entry) === path);
        if (!current || current.path !== prepared.path) throw new Error("Исходный проект изменился во время копирования. Копия не добавлена.");
        const names = new Set(this.getAllProjects().map((entry) => entry.name));
        const baseName = `${current.name} (копия)`;
        let name = baseName;
        for (let suffix = 2; names.has(name); suffix++) name = `${baseName} ${suffix}`;
        const profile: ProjectInfo = { ...current, id: `project-${randomUUID()}`, name, path: targetPath };
        targetKey = projectKey(profile);
        const password = await this.context.secrets.get(this.passwordKey(path));
        const env = await this.context.secrets.get(this.secretEnvKey(path));
        if (password !== undefined) await this.context.secrets.store(this.passwordKey(targetKey), password);
        if (env !== undefined) await this.context.secrets.store(this.secretEnvKey(targetKey), env);
        const cfg = vscode.workspace.getConfiguration("agentHub");
        const configured = [...(cfg.get<ProjectInfo[]>("projects", []) ?? []), profile];
        await cfg.update("projects", configured, vscode.ConfigurationTarget.Global);
        profilePersisted = true;
        await this.setActivePath(targetKey);
        this.postFullState();
        await this.postSettings();
        this.post({ type: "info", text: `Копия проекта «${profile.name}» создана и выбрана.` });
      });
    } catch (err) {
      if (!profilePersisted) {
        if (targetKey) {
          try { await this.context.secrets.delete(this.passwordKey(targetKey)); } catch { /* best-effort cleanup */ }
          try { await this.context.secrets.delete(this.secretEnvKey(targetKey)); } catch { /* best-effort cleanup */ }
        }
        if (copiedFolder) await fs.promises.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      }
      void vscode.window.showErrorMessage(`Не удалось создать копию проекта: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      for (const directory of reserved) this.folderCopyReservations?.delete(directory);
    }
  }

  /** Ordering changes broadcast registry rows without replaying chat transcripts. */
  private postProjectRegistry() {
    const projects = this.getProjects();
    const archivedProjects = this.getArchivedProjects();
    const active = this.getActiveProject();
    this.post({ type: "projects", projects, archivedProjects, activePath: active ? projectKey(active) : "" });
    this.postMultiBoardState();
    for (const slot of this.getChatSlots()) {
      this.postScoped(slot.projectPath, { type: "projects", projects, archivedProjects, activePath: slot.projectPath }, slot.chatId);
    }
  }

  private async moveProject(path: string, direction: "up" | "down") {
    const all = this.getAllProjects();
    const activeKeys = this.getProjects().map(projectKey);
    if (!activeKeys.includes(path) || (direction !== "up" && direction !== "down")) return;
    const active = this.getActiveProject();
    const next = moveInProjectOrder(all.map(projectKey), activeKeys, path, direction);
    if (active) await this.setActivePath(projectKey(active));
    await this.context.globalState.update(PROJECT_ORDER_KEY, next);
    this.postProjectRegistry();
  }

  private async reorderProjects(paths: string[]) {
    const allKeys = this.getAllProjects().map(projectKey);
    const next = applyActiveProjectOrder(allKeys, this.getProjects().map(projectKey), paths);
    if (!next) return;
    const active = this.getActiveProject();
    if (active) await this.setActivePath(projectKey(active));
    await this.context.globalState.update(PROJECT_ORDER_KEY, next);
    this.postProjectRegistry();
  }

  /** Original paths/keys stay stable so archived history and Keychain entries are preserved. */
  async archiveProject(path: string) {
    await this.changeProjectArchive(path, false);
  }

  async restoreProject(path: string) {
    await this.changeProjectArchive(path, true);
  }

  async showArchive() {
    const archived = this.getArchivedProjects();
    if (!archived.length) {
      void vscode.window.showInformationMessage("Архив проектов пуст.");
      return;
    }
    const picked = await vscode.window.showQuickPick(archived.map((project) => ({
      label: project.name,
      description: project.archive!.path,
      detail: `Восстановить в ${project.path}`,
      key: projectKey(project),
    })), { title: "Архив проектов Agent Hub", placeHolder: "Выберите проект для восстановления" });
    if (picked) await this.restoreProject(picked.key);
  }

  private archiveGroup(project: ProjectInfo): ProjectInfo[] {
    const physical = physicalDirectory(project.archive?.path ?? project.path);
    return this.getAllProjects().filter((entry) =>
      physicalDirectory(entry.archive?.path ?? entry.path) === physical);
  }

  private assertArchiveMoveAllowed(project: ProjectInfo, group: ProjectInfo[], destination?: string) {
    const source = physicalDirectory(project.archive?.path ?? project.path);
    const affected = destination ? [source, physicalDirectory(destination)] : [source];
    const overlaps = (directory: string) => affected.some((path) => directoriesOverlap(path, physicalDirectory(directory)));
    if (new Set(group.map((entry) => nodePath.resolve(entry.path))).size !== 1 ||
        group.some((entry) => !!entry.archive !== !!project.archive)) {
      throw new Error("Эта папка зарегистрирована через разные пути или символические ссылки. Приведите профили к одному обычному пути перед архивированием.");
    }
    for (const directory of this.folderCopyReservations ?? []) {
      if (overlaps(directory)) throw new Error("Папка сейчас копируется. Дождитесь завершения копирования перед перемещением.");
    }
    const keys = new Set(group.map(projectKey));
    for (const entry of this.getAllProjects()) {
      if (!keys.has(projectKey(entry)) && overlaps(entry.archive?.path ?? entry.path)) {
        throw new Error(`Папка пересекается с другим проектом «${entry.name}»: ${entry.path}. Сначала уберите вложенный проект из реестра.`);
      }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (overlaps(folder.uri.fsPath)) {
        throw new Error(`Папка открыта в текущем workspace (${folder.uri.fsPath}). Сначала закройте её (File → Remove Folder from Workspace), затем повторите операцию.`);
      }
    }
    for (const [directory, running] of this.directoryRuns ?? []) {
      if (running.controllers.size && overlaps(directory)) {
        throw new Error("В этой папке или вложенном проекте сейчас работает агент. Дождитесь завершения всех ходов перед перемещением.");
      }
    }
    for (const [runKey] of this.runs) {
      const slot = this.findChatSlot(runKey);
      const key = slot?.projectPath ?? runKey;
      const running = this.getAllProjects().find((entry) => projectKey(entry) === key);
      if (keys.has(key) || (running && overlaps(running.archive?.path ?? running.path))) {
        throw new Error("В этой папке сейчас работает агент. Дождитесь завершения всех ходов перед перемещением.");
      }
    }
  }

  private async changeProjectArchive(key: string, restoring: boolean) {
    try {
      const project = this.getAllProjects().find((entry) => projectKey(entry) === key);
      if (!project || !!project.archive !== restoring) return;
      const group = this.archiveGroup(project);
      this.assertArchiveMoveAllowed(project, group);
      const preview = await planProjectMove(project.path, project.archive);
      this.assertArchiveMoveAllowed(project, group, preview.destination);
      const action = restoring ? "Восстановить" : "Архивировать";
      const detail = `${preview.source}\n→ ${preview.destination}\n\n` +
        (group.length > 1 ? "Одну папку используют несколько профилей. Будут перемещены все:\n" : "Профиль проекта:\n") +
        group.map((entry) => `• ${entry.name} — ${entry.path}`).join("\n") +
        "\n\nПапка перемещается целиком, включая .git и скрытые файлы. История чатов и доступы сохраняются." +
        "\nПеред перемещением закройте эту папку в других окнах VS Code и завершите агентов, запущенных вне этого окна.";
      // Do not hold the mutation queue while a user decides in the native modal.
      const choice = await vscode.window.showWarningMessage(`${action} проект «${project.name}»?`, { modal: true, detail }, action);
      if (choice !== action) return;
      await this.serializeMultiMutation(async () => {
        if (this.context.globalState.get<PendingProjectMove | undefined>(PROJECT_MOVE_KEY)) {
          throw new Error("Не завершено предыдущее перемещение проекта. Перезапустите окно VS Code для восстановления состояния.");
        }
        const current = this.getAllProjects().find((entry) => projectKey(entry) === key);
        if (!current || !!current.archive !== restoring) return;
        const currentGroup = this.archiveGroup(current);
        if (group.map(projectKey).sort().join("\n") !== currentGroup.map(projectKey).sort().join("\n")) {
          throw new Error("Список профилей этой папки изменился. Повторите операцию, чтобы подтвердить актуальный список.");
        }
        this.assertArchiveMoveAllowed(current, currentGroup);
        const plan = await planProjectMove(current.path, current.archive);
        this.assertArchiveMoveAllowed(current, currentGroup, plan.destination);
        if (plan.source !== preview.source || plan.destination !== preview.destination) {
          throw new Error("Адрес перемещения изменился. Повторите операцию для подтверждения нового адреса.");
        }
        const cfg = vscode.workspace.getConfiguration("agentHub");
        const list = [...(cfg.get<ProjectInfo[]>("projects", []) ?? [])];
        const activeBeforeMove = this.getActiveProject();
        const keys = new Set(currentGroup.map(projectKey));
        // Materialize implicit workspace profiles as well; identities remain unchanged.
        for (const entry of currentGroup) {
          if (!list.some((item) => configuredProjectKey(item) === projectKey(entry))) list.push(entry);
        }
        const nextProjects = list.map((entry) => {
          if (!keys.has(configuredProjectKey(entry))) return entry;
          const { archive: _oldArchive, ...active } = entry;
          return restoring ? active : { ...active, archive: { path: plan.archivePath, archivedAt: Date.now() } };
        });
        // Persist intent before touching files. On extension-host interruption it can be reconciled.
        const pending: PendingProjectMove = { plan, keys: [...keys], nextProjects };
        await this.context.globalState.update(PROJECT_MOVE_KEY, pending);
        try {
          await executeProjectMove(plan, {
            rename: async (source, destination) => { await vscode.workspace.fs.rename(vscode.Uri.file(source), vscode.Uri.file(destination), { overwrite: false }); },
            persist: async () => { await cfg.update("projects", nextProjects, vscode.ConfigurationTarget.Global); },
          });
        } catch (error) {
          if (await pathEntryExists(plan.source) && !await pathEntryExists(plan.destination)) {
            await this.context.globalState.update(PROJECT_MOVE_KEY, undefined);
          }
          throw error;
        }
        // A failure to clear intent is safe: recovery sees that registry/files agree.
        await Promise.resolve(this.context.globalState.update(PROJECT_MOVE_KEY, undefined)).catch(() => undefined);
        if (!restoring && activeBeforeMove && keys.has(projectKey(activeBeforeMove))) {
          const nextActive = this.getProjects()[0];
          await this.setActivePath(nextActive ? projectKey(nextActive) : "");
        }
        this.postFullState();
        await this.postSettings();
        this.post({ type: "info", text: restoring
          ? `Проект «${current.name}» восстановлен: ${plan.destination}`
          : `Проект «${current.name}» перемещён в архив: ${plan.destination}` });
      });
    } catch (error) {
      void vscode.window.showErrorMessage(`Перемещение проекта не выполнено: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Finish a rename interrupted between filesystem and configuration persistence. */
  private async recoverPendingProjectMove() {
    const pending = this.context.globalState.get<PendingProjectMove | undefined>(PROJECT_MOVE_KEY);
    if (!pending) return;
    try {
      const { plan, keys, nextProjects } = pending;
      if (!plan || !Array.isArray(keys) || !Array.isArray(nextProjects) ||
          !normalizeProjectArchive(plan.originalPath, { path: plan.archivePath, archivedAt: 0 }) ||
          plan.source !== (plan.restoring ? plan.archivePath : plan.originalPath) ||
          plan.destination !== (plan.restoring ? plan.originalPath : plan.archivePath)) {
        throw new Error("Некорректная запись незавершённого перемещения; требуется ручная проверка настроек.");
      }
      const sourceExists = await pathEntryExists(plan.source);
      const destinationExists = await pathEntryExists(plan.destination);
      if (sourceExists && !destinationExists) {
        await this.context.globalState.update(PROJECT_MOVE_KEY, undefined);
        return;
      }
      if (sourceExists || !destinationExists) throw new Error("Оба адреса заняты либо папка отсутствует по обоим адресам.");
      const moved = await fs.promises.lstat(plan.destination);
      if (!moved.isDirectory() || moved.isSymbolicLink()) throw new Error("На конечном адресе находится не обычная папка.");
      const cfg = vscode.workspace.getConfiguration("agentHub");
      const list = [...(cfg.get<ProjectInfo[]>("projects", []) ?? [])];
      for (const key of keys) {
        const expected = nextProjects.find((entry) => configuredProjectKey(entry) === key);
        if (!expected || nodePath.resolve(expandProjectPath(expected.path)) !== plan.originalPath ||
            (plan.restoring ? !!expected.archive : normalizeProjectArchive(expected.path, expected.archive)?.path !== plan.archivePath)) {
          throw new Error("В журнале отсутствует корректный профиль перемещённой папки.");
        }
        const index = list.findIndex((entry) => configuredProjectKey(entry) === key);
        if (index < 0) list.push(expected);
        else {
          if (nodePath.resolve(expandProjectPath(list[index].path)) !== plan.originalPath) {
            throw new Error(`Адрес профиля «${list[index].name}» изменён после перемещения. Верните путь ${plan.originalPath} в настройках и перезапустите окно VS Code.`);
          }
          const { archive: _oldArchive, ...entry } = list[index];
          list[index] = expected.archive ? { ...entry, archive: expected.archive } : entry;
        }
      }
      await cfg.update("projects", list, vscode.ConfigurationTarget.Global);
      await this.context.globalState.update(PROJECT_MOVE_KEY, undefined);
      this.postFullState();
    } catch (error) {
      const plan = pending.plan;
      void vscode.window.showErrorMessage(`Не удалось завершить перемещение проекта. Исходный адрес: ${plan?.source}; конечный адрес: ${plan?.destination}. Файлы не удалялись. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Удаление проекта: «убрать из списка» (файлы не трогаем, история сессий
   * сохраняется на случай возврата) или «удалить с диска» (папка — в Корзину,
   * пароль и история сессий вычищаются).
   */
  async deleteProject(path: string) {
    const project = this.getProjects().find((p) => projectKey(p) === path);
    if (!project) return;
    const isWorkspaceFolder = (vscode.workspace.workspaceFolders ?? []).some(
      (f) => physicalDirectory(f.uri.fsPath) === physicalDirectory(project.path),
    );

    const LIST_ONLY = "Убрать из списка";
    const WITH_FOLDER = "Удалить вместе с папкой";
    const choice = await vscode.window.showWarningMessage(
      `Удалить проект «${project.name}»?`,
      {
        modal: true,
        detail:
          `${project.path}\n\n«${LIST_ONLY}» — файлы не трогаем, историю сессий сохраняем.\n` +
          `«${WITH_FOLDER}» — папка отправится в Корзину, история и пароль будут удалены.`,
      },
      LIST_ONLY,
      WITH_FOLDER,
    );
    if (!choice) return;

    if (choice === WITH_FOLDER && this.getProjects().some((p) =>
      projectKey(p) !== path && physicalDirectory(p.path) === physicalDirectory(project.path))) {
      void vscode.window.showErrorMessage("Эту папку использует другой профиль проекта. Можно убрать выбранный профиль из списка.");
      return;
    }

    if (choice === WITH_FOLDER && isWorkspaceFolder) {
      void vscode.window.showErrorMessage(
        `Папка «${project.name}» открыта в текущем workspace — сначала закройте её (File → Remove Folder from Workspace), потом удаляйте с диска.`,
      );
      return;
    }

    if (choice === WITH_FOLDER) {
      const confirm = await vscode.window.showWarningMessage(
        `Точно удалить папку с диска?`,
        { modal: true, detail: `${project.path}\n\nПапка будет отправлена в Корзину (восстановимо).` },
        "Да, удалить папку",
      );
      if (confirm !== "Да, удалить папку") return;
      if (this.getProjects().some((p) => projectKey(p) !== path &&
          physicalDirectory(p.path) === physicalDirectory(project.path))) {
        void vscode.window.showErrorMessage("Эту папку теперь использует другой профиль проекта. Удаление отменено.");
        return;
      }
    }

    await this.serializeMultiMutation(async () => {
      const current = this.getProjects().find((entry) => projectKey(entry) === path);
      if (!current || current.path !== project.path) return;
      if (this.context.globalState.get(PROJECT_MOVE_KEY)) {
        void vscode.window.showErrorMessage("Сначала завершите восстановление незавершённого перемещения проекта.");
        return;
      }
      if (choice === WITH_FOLDER && ((vscode.workspace.workspaceFolders ?? []).some((folder) =>
          physicalDirectory(folder.uri.fsPath) === physicalDirectory(current.path)) ||
          [...(this.folderCopyReservations ?? [])].some((directory) => directoriesOverlap(directory, physicalDirectory(current.path))))) {
        void vscode.window.showErrorMessage("Папка открыта в workspace или сейчас копируется. Закройте папку и дождитесь завершения копирования.");
        return;
      }
      if (choice === WITH_FOLDER && this.getAllProjects().some((entry) => projectKey(entry) !== path &&
          directoriesOverlap(physicalDirectory(current.path), physicalDirectory(entry.archive?.path ?? entry.path)))) {
        void vscode.window.showErrorMessage("Папка используется другим или вложенным проектом. Удаление с диска отменено.");
        return;
      }
      // Останавливаем legacy run and every multi-chat slot bound to this profile.
      this.runs.get(path)?.abort();
      const removedChatIds = this.getChatSlots().filter((slot) => slot.projectPath === path).map((slot) => slot.chatId);
      for (const chatId of removedChatIds) {
        this.runs.get(chatId)?.abort();
        this.denyAllPending(path, chatId);
      }
      if (removedChatIds.length) {
        const removed = new Set(removedChatIds);
        await this.saveChatSlots(this.getChatSlots().filter((slot) => !removed.has(slot.chatId)));
      }
      this.denyAllPending(path);

      // Из реестра — в любом случае.
      const cfg = vscode.workspace.getConfiguration("agentHub");
      const list = (cfg.get<ProjectInfo[]>("projects", []) ?? []).filter(
        (p) => configuredProjectKey(p) !== path,
      );
      await cfg.update("projects", list, vscode.ConfigurationTarget.Global);
      if (this.getActivePathRaw() === path) await this.setActivePath(undefined);
      if (this.context.globalState.get<string>(ACTIVE_PROJECT_KEY) === path) {
        await this.context.globalState.update(ACTIVE_PROJECT_KEY, undefined);
      }
      // Папка workspace иначе вернётся в список автоматически — помечаем скрытой.
      if (isWorkspaceFolder) {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          if (physicalDirectory(folder.uri.fsPath) === physicalDirectory(project.path)) {
            await this.setProjectHidden(folder.uri.fsPath, true);
          }
        }
      }

      if (choice === WITH_FOLDER) {
        // Пароль, доступы и историю сессий вычищаем вместе с папкой.
        await this.context.secrets.delete(this.passwordKey(path));
        await this.context.secrets.delete(this.secretEnvKey(path));
        const all = { ...this.getStoreAll() };
        delete all[path];
        await this.context.globalState.update(STORE_KEY, all);
        try {
          // Registry/secrets writes above yield: another profile may have been
          // created since confirmation. Keep its shared files intact.
          if (this.getProjects().some((p) => projectKey(p) !== path &&
              physicalDirectory(p.path) === physicalDirectory(project.path))) {
            this.abortOrphanRuns();
            this.postFullState();
            await this.postSettings();
            this.post({ type: "info", text: "Выбранный профиль удалён из списка; папка сохранена, потому что её использует другой профиль." });
            return;
          }
          await vscode.workspace.fs.delete(vscode.Uri.file(project.path), {
            recursive: true,
            useTrash: true,
          });
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Проект убран из списка, но папку удалить не удалось: ${err instanceof Error ? err.message : err}`,
          );
          this.abortOrphanRuns();
          this.postFullState();
          await this.postSettings();
          return;
        }
      }

      this.abortOrphanRuns();
      this.postFullState();
      await this.postSettings();
      this.post({
        type: "info",
        text:
          choice === WITH_FOLDER
            ? `Проект «${project.name}» удалён, папка отправлена в Корзину.`
            : isWorkspaceFolder
              ? `Проект «${project.name}» убран из списка (папка остаётся открытой в workspace). Вернуть — «＋ Добавить проект…».`
              : `Проект «${project.name}» убран из списка. Файлы и история сессий не тронуты.`,
      });
    });
  }

  /** Native forms may remain open while another surface archives a project. */
  private async updateRegisteredProject(key: string, update: (entry: ProjectInfo) => void): Promise<boolean> {
    return this.serializeMultiMutation(async () => {
      const current = this.getProjects().find((entry) => projectKey(entry) === key);
      if (!current) return false;
      const cfg = vscode.workspace.getConfiguration("agentHub");
      const list = [...(cfg.get<ProjectInfo[]>("projects", []) ?? [])];
      const idx = list.findIndex((entry) => configuredProjectKey(entry) === key);
      const entry = { ...(idx >= 0 ? list[idx] : current) };
      update(entry);
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      await cfg.update("projects", list, vscode.ConfigurationTarget.Global);
      return true;
    });
  }

  /** Ручное редактирование полей активного проекта. */
  async editProject() {
    const active = this.getActiveProject();
    if (!active) {
      void vscode.window.showWarningMessage("Сначала добавьте проект.");
      return;
    }

    type Field = { key: keyof ProjectInfo; label: string; placeholder?: string };
    const fields: Field[] = [
      { key: "name", label: "Название" },
      { key: "githubRepo", label: "GitHub-репозиторий", placeholder: "https://github.com/user/repo" },
      { key: "branch", label: "Рабочая ветка git", placeholder: "main" },
      { key: "serverHost", label: "Хост / SSH-алиас сервера", placeholder: "1.2.3.4 или proj1" },
      { key: "serverPort", label: "Порт сервера", placeholder: "пусто — стандартный (22 / 21)" },
      { key: "serverUser", label: "Логин на сервере", placeholder: "deploy" },
      { key: "server", label: "Заметки о сервере", placeholder: "прод, логи, деплой…" },
    ];

    const pick = await vscode.window.showQuickPick(
      [
        ...fields.map((f) => ({
          label: f.label,
          description: String(active[f.key] ?? "") || "— не задано —",
          field: f as Field | null,
          action: "edit" as const,
        })),
        {
          label: "Протокол сервера",
          description: (active.serverProtocol ?? "ssh").toUpperCase(),
          field: null,
          action: "protocol" as const,
        },
        {
          label: "$(trash) Удалить проект из списка",
          description: "файлы на диске не трогаем",
          field: null,
          action: "delete" as const,
        },
      ],
      { placeHolder: `Проект «${active.name}» — что изменить?`, ignoreFocusOut: true },
    );
    if (!pick) return;

    if (pick.action === "protocol") {
      const protoPick = await vscode.window.showQuickPick(
        [
          { label: "SSH", description: "полный доступ к шеллу", value: "ssh" as const },
          { label: "SFTP", description: "файлы поверх SSH", value: "sftp" as const },
          { label: "FTP", description: "классический FTP", value: "ftp" as const },
        ],
        { placeHolder: `Протокол сервера для «${active.name}»`, ignoreFocusOut: true },
      );
      if (!protoPick) return;
      const updated = await this.updateRegisteredProject(projectKey(active), (entry) => {
        if (protoPick.value === "ssh") delete entry.serverProtocol;
        else entry.serverProtocol = protoPick.value;
      });
      if (!updated) return;
      this.postFullState();
      this.post({ type: "info", text: `Протокол сервера: ${protoPick.label}.` });
      return;
    }

    if (pick.action === "delete") {
      await this.deleteProject(projectKey(active));
      return;
    }

    const field = pick.field!;
    const value = await vscode.window.showInputBox({
      prompt: `${field.label} — проект «${active.name}» (пусто — очистить поле)`,
      value: String(active[field.key] ?? ""),
      placeHolder: field.placeholder,
      ignoreFocusOut: true,
      validateInput:
        field.key === "serverPort"
          ? (v) => (v && (!/^\d+$/.test(v) || +v < 1 || +v > 65535) ? "Порт: число 1–65535" : null)
          : undefined,
    });
    if (value === undefined) return;

    // Папки workspace, не записанные в реестр, при первом изменении попадают в него.
    const updated = await this.updateRegisteredProject(projectKey(active), (entry) => {
      if (value) {
        (entry as unknown as Record<string, unknown>)[field.key] =
          field.key === "serverPort" ? parseInt(value, 10) : value;
      } else if (field.key === "name") {
        entry.name = nodePath.basename(entry.path);
      } else {
        delete (entry as unknown as Record<string, unknown>)[field.key];
      }
    });
    if (!updated) return;
    this.postFullState();
    this.post({ type: "info", text: `Проект обновлён: ${field.label.toLowerCase()}.` });
  }

  // ---------- Проверка соединения с сервером ----------

  /** Проверяется черновик указанного проекта, без изменения сохранённых настроек. */
  private async testServer(msg: Extract<WebviewToHost, { type: "testServer" }>) {
    const report = (ok: boolean, message: string) =>
      this.post({
        type: "serverTestResult", projectPath: msg.projectPath,
        requestId: msg.requestId, ok, message,
      });
    const project = this.getProjects().find((p) => projectKey(p) === msg.projectPath);
    if (!project) {
      report(false, "Проект удалён или недоступен. Откройте настройки проекта заново.");
      return;
    }
    const savedPassword = msg.password === undefined
      ? await this.context.secrets.get(this.passwordKey(projectKey(project)))
      : msg.password;
    const env = buildServerEnvironment(await this.getSecretEnv(projectKey(project)), savedPassword);
    const result = await testServerConnection({
      host: msg.host, user: msg.user, protocol: msg.protocol, port: msg.port,
    }, env.AGENT_HUB_SERVER_PASSWORD);
    report(result.ok, result.message);
  }

  // ---------- Автокоммит изменений агента ----------

  /** git в папке проекта; вывод собирается, таймаут страхует зависания. */
  private execGit(
    cwd: string,
    args: string[],
    timeoutMs = 30000,
  ): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn("git", args, { cwd, env: process.env });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", (e: Error) => {
        clearTimeout(timer);
        resolve({ code: 127, out, err: String(e) });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, out, err });
      });
    });
  }

  /**
   * Перед ходом: подтянуть новые коммиты из origin, чтобы агент работал с
   * актуальной версией (парная половинка к автокоммиту/автопушу при работе
   * с нескольких устройств). Fast-forward, при расхождении — rebase с
   * автостэшем; конфликт не решаем — предупреждаем и работаем на текущей.
   */
  private async autoPull(cwd: string, eventKey = cwd, chatId?: string) {
    const cfg = vscode.workspace.getConfiguration("agentHub");
    if (!cfg.get<boolean>("autoPull", true)) return;

    const inRepo = await this.execGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inRepo.code !== 0 || !inRepo.out.trim().startsWith("true")) return;
    const remotes = await this.execGit(cwd, ["remote"]);
    if (remotes.code !== 0 || !remotes.out.trim()) return;

    this.postScoped(eventKey, { type: "activity", label: "Проверяю обновления в origin…" }, chatId);
    const fetched = await this.execGit(cwd, ["fetch", "--quiet"], 30000);
    if (fetched.code !== 0) return; // офлайн/нет доступа — работаем с тем, что есть

    const branchRes = await this.execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchRes.out.trim();
    if (branchRes.code !== 0 || !branch || branch === "HEAD") return;

    // Upstream ветки; не настроен — пробуем одноимённую в origin.
    let upstream = "";
    const up = await this.execGit(cwd, [
      "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}",
    ]);
    if (up.code === 0 && up.out.trim()) {
      upstream = up.out.trim();
    } else {
      const cand = `origin/${branch}`;
      const verify = await this.execGit(cwd, ["rev-parse", "--verify", "--quiet", cand]);
      if (verify.code === 0) upstream = cand;
    }
    if (!upstream) return;

    const behindRes = await this.execGit(cwd, ["rev-list", "--count", `HEAD..${upstream}`]);
    const behind = behindRes.code === 0 ? parseInt(behindRes.out.trim(), 10) || 0 : 0;
    if (behind === 0) return;

    const aheadRes = await this.execGit(cwd, ["rev-list", "--count", `${upstream}..HEAD`]);
    const ahead = aheadRes.code === 0 ? parseInt(aheadRes.out.trim(), 10) || 0 : 0;

    this.postScoped(eventKey, { type: "activity", label: `Подтягиваю новые коммиты (${behind})…` }, chatId);
    let ok: boolean;
    if (ahead === 0) {
      const merge = await this.execGit(
        cwd,
        ["merge", "--ff-only", "--autostash", upstream],
        60000,
      );
      ok = merge.code === 0;
    } else {
      const rebase = await this.execGit(cwd, ["rebase", "--autostash", upstream], 60000);
      ok = rebase.code === 0;
      if (!ok) await this.execGit(cwd, ["rebase", "--abort"]);
    }

    if (ok) {
      const sha = await this.execGit(cwd, ["rev-parse", "--short", "HEAD"]);
      this.postScoped(eventKey, {
        type: "info",
        text: `Подтянуты обновления из ${upstream}: коммитов — ${behind}. Теперь HEAD ${sha.out.trim()}.`,
      }, chatId);
    } else {
      this.postScoped(eventKey, {
        type: "info",
        text:
          `⚠️ В ${upstream} есть новые коммиты (${behind}), но обновиться автоматически не удалось ` +
          `(конфликт или несовместимые локальные изменения). Ход продолжится на текущей версии.`,
      }, chatId);
    }
  }

  /**
   * Автокоммит после хода: все изменения в папке проекта → git add -A +
   * commit с заголовком из промпта (+ опциональный push). Claude и Codex
   * проходят через одну точку — runTurn, поэтому покрыты оба.
   */
  private async autoCommit(cwd: string, agent: AgentId, prompt: string, eventKey = cwd, chatId?: string) {
    const cfg = vscode.workspace.getConfiguration("agentHub");
    if (!cfg.get<boolean>("autoCommit", true)) return;
    const short = (s: string) => {
      const line = s.trim().split("\n").filter(Boolean).pop() ?? "неизвестная ошибка";
      return line.length > 180 ? line.slice(0, 180) + "…" : line;
    };

    const inRepo = await this.execGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inRepo.code !== 0 || !inRepo.out.trim().startsWith("true")) return;

    // Служебная папка панели (вложенные скриншоты) — не для репозитория;
    // пишем в .git/info/exclude, чтобы не трогать пользовательский .gitignore.
    const gitDir = await this.execGit(cwd, ["rev-parse", "--absolute-git-dir"]);
    if (gitDir.code === 0 && gitDir.out.trim()) {
      const exclude = nodePath.join(gitDir.out.trim(), "info", "exclude");
      try {
        const cur = await fs.promises.readFile(exclude, "utf8").catch(() => "");
        if (!cur.includes(".agent-hub/")) {
          await fs.promises.mkdir(nodePath.dirname(exclude), { recursive: true });
          await fs.promises.writeFile(
            exclude,
            cur + (cur === "" || cur.endsWith("\n") ? "" : "\n") + ".agent-hub/\n",
          );
        }
      } catch {
        // не критично
      }
    }

    const status = await this.execGit(cwd, ["status", "--porcelain"]);
    if (status.code !== 0 || !status.out.trim()) return;
    const changed = status.out.trim().split("\n").length;

    this.postScoped(eventKey, { type: "activity", label: "Коммичу изменения…" }, chatId);
    const add = await this.execGit(cwd, ["add", "-A"]);
    if (add.code !== 0) {
      this.postScoped(eventKey, { type: "info", text: `Автокоммит: git add не удался — ${short(add.err)}` }, chatId);
      return;
    }

    const title = prompt.trim().split("\n")[0].replace(/\s+/g, " ").slice(0, 72);
    const message = `авто (${agent}): ${title || "изменения после хода агента"}`;
    let commit = await this.execGit(cwd, ["commit", "-m", message]);
    if (commit.code !== 0 && /tell me who you are|user\.(name|email)/i.test(commit.err)) {
      // В репозитории не настроена личность git — коммитим от имени панели.
      commit = await this.execGit(cwd, [
        "-c", "user.name=Agent Hub",
        "-c", "user.email=agent-hub@local",
        "commit", "-m", message,
      ]);
    }
    if (commit.code !== 0) {
      this.postScoped(eventKey, {
        type: "info",
        text: `Автокоммит не удался: ${short(commit.err || commit.out)}`,
      }, chatId);
      return;
    }
    const sha = await this.execGit(cwd, ["rev-parse", "--short", "HEAD"]);
    this.postScoped(eventKey, {
      type: "info",
      text: `Автокоммит ${sha.out.trim()}: файлов в изменениях — ${changed}.`,
    }, chatId);

    if (!cfg.get<boolean>("autoPush", false)) return;
    this.postScoped(eventKey, { type: "activity", label: "Пушу в origin…" }, chatId);
    let push = await this.execGit(cwd, ["push"], 60000);
    if (push.code !== 0 && /no upstream|set-upstream/i.test(push.err)) {
      push = await this.execGit(cwd, ["push", "-u", "origin", "HEAD"], 60000);
    }
    this.postScoped(eventKey, {
      type: "info",
      text: push.code === 0 ? "Изменения запушены в origin." : `Пуш не удался: ${short(push.err)}`,
    }, chatId);
  }

  // ---------- Импорт/экспорт всех настроек ----------

  /** Все настройки Agent Hub одним объектом (пароли — нет, они в Keychain). */
  private collectAllSettings() {
    const cfg = vscode.workspace.getConfiguration("agentHub");
    return {
      claude: {
        model: cfg.get<string>("claude.model", ""),
        effort: cfg.get<string>("claude.effort", ""),
        permissionMode: cfg.get<string>("claude.permissionMode", "default"),
        maxTurns: cfg.get<number>("claude.maxTurns", 0),
        contextWindow: cfg.get<number>("claude.contextWindow", 0) === 200000 ? 0 : cfg.get<number>("claude.contextWindow", 0),
      },
      codex: {
        model: cfg.get<string>("codex.model", ""),
        effort: cfg.get<string>("codex.effort", ""),
        sandbox: cfg.get<string>("codex.sandbox", "workspace-write"),
        yolo: cfg.get<boolean>("codex.yolo", false),
        contextWindow: cfg.get<number>("codex.contextWindow", 0) === 400000 ? 0 : cfg.get<number>("codex.contextWindow", 0),
      },
      journalDir: cfg.get<string>("journalDir", "docs/journal"),
      journalContextEntries: cfg.get<number>("journalContextEntries", 3),
      autoAllowTools: cfg.get<string[]>("autoAllowTools", []),
      autoAllowBash: cfg.get<string[]>("autoAllowBash", []),
      autoCommit: cfg.get<boolean>("autoCommit", true),
      autoPush: cfg.get<boolean>("autoPush", false),
      autoPull: cfg.get<boolean>("autoPull", true),
      autoScrollMode: cfg.get<string>("autoScrollMode", "perProject"),
      // Реестр + папки workspace — на другой машине всё станет реестром.
      projects: this.getAllProjects(),
    };
  }

  /** Применить блок настроек (без проектов) из внешнего объекта. */
  private async applySettingsFields(settings: Record<string, unknown>) {
    const cfg = vscode.workspace.getConfiguration("agentHub");
    const g = vscode.ConfigurationTarget.Global;
    const claude = settings.claude as Record<string, unknown> | undefined;
    const codex = settings.codex as Record<string, unknown> | undefined;
    const setIf = async (key: string, value: unknown, type: string) => {
      if (typeof value === type) await cfg.update(key, value, g);
    };
    if (claude) {
      await setIf("claude.model", claude.model, "string");
      await setIf("claude.effort", claude.effort, "string");
      await setIf("claude.permissionMode", claude.permissionMode, "string");
      await setIf("claude.maxTurns", claude.maxTurns, "number");
      await setIf("claude.contextWindow", claude.contextWindow, "number");
    }
    if (codex) {
      await setIf("codex.model", codex.model, "string");
      await setIf("codex.effort", codex.effort, "string");
      await setIf("codex.sandbox", codex.sandbox, "string");
      await setIf("codex.yolo", codex.yolo, "boolean");
      await setIf("codex.contextWindow", codex.contextWindow, "number");
    }
    await setIf("journalDir", settings.journalDir, "string");
    await setIf("journalContextEntries", settings.journalContextEntries, "number");
    await setIf("autoCommit", settings.autoCommit, "boolean");
    await setIf("autoPush", settings.autoPush, "boolean");
    await setIf("autoPull", settings.autoPull, "boolean");
    await setIf("autoScrollMode", settings.autoScrollMode, "string");
    if (Array.isArray(settings.autoAllowTools)) {
      await cfg.update("autoAllowTools", settings.autoAllowTools, g);
    }
    if (Array.isArray(settings.autoAllowBash)) {
      await cfg.update("autoAllowBash", settings.autoAllowBash, g);
    }
  }

  /** A stale settings/export snapshot cannot change a completed filesystem move. */
  private preserveProjectArchiveState(project: ProjectInfo): ProjectInfo {
    const existing = this.getAllProjects();
    const previous = existing.find((entry) => projectKey(entry) === configuredProjectKey(project)) ??
      existing.find((entry) => physicalDirectory(entry.path) === physicalDirectory(expandProjectPath(project.path)));
    if (!previous) return project;
    const { archive: _incomingArchive, ...entry } = project;
    return previous.archive ? { ...entry, path: previous.path, archive: previous.archive } : entry;
  }

  private preserveArchivedProjects(incoming: ProjectInfo[]): ProjectInfo[] {
    const list = incoming.map((project) => this.preserveProjectArchiveState(project));
    for (const project of this.getArchivedProjects()) {
      if (!list.some((entry) => configuredProjectKey(entry) === projectKey(project))) list.push(project);
    }
    return list;
  }

  /**
   * Применить конфиг, отредактированный прямо в настройках (JSON-редактор).
   * Настройки перезаписываются; список проектов ЗАМЕНЯЕТСЯ целиком.
   */
  async applyConfigJson(json: string, serialized = false): Promise<void> {
    if (!serialized) return this.serializeMultiMutation(() => this.applyConfigJson(json, true));
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      this.post({
        type: "configJsonResult",
        ok: false,
        message: `Некорректный JSON: ${err instanceof Error ? err.message : err}`,
      });
      return;
    }

    // Принимаем и обёртку {settings: {...}}, и «голый» объект настроек.
    const wrapped = (parsed as { settings?: unknown }).settings;
    const settings =
      wrapped && typeof wrapped === "object"
        ? (wrapped as Record<string, unknown>)
        : (parsed as Record<string, unknown>);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      this.post({
        type: "configJsonResult",
        ok: false,
        message: "Ожидается объект настроек (как в поле выше) или {\"settings\": {...}}.",
      });
      return;
    }

    await this.applySettingsFields(settings);

    let projectsNote = "";
    if (Array.isArray(settings.projects)) {
      const list = this.preserveArchivedProjects(normalizeProjects(settings.projects));
      await vscode.workspace
        .getConfiguration("agentHub")
        .update("projects", list, vscode.ConfigurationTarget.Global);
      projectsNote = ` Проектов в реестре: ${list.length}.`;
      this.abortOrphanRuns();
    }

    this.postFullState();
    await this.postSettings();
    this.post({
      type: "configJsonResult",
      ok: true,
      message: `Конфиг применён.${projectsNote}`,
    });
  }

  /** Экспорт абсолютно всех настроек в JSON-файл. */
  async exportSettings() {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(nodePath.join(os.homedir(), "agent-hub-settings.json")),
      filters: { JSON: ["json"] },
      saveLabel: "Экспортировать",
    });
    if (!target) return;

    const payload = {
      agentHub: "settings",
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: this.collectAllSettings(),
    };
    await fs.promises.writeFile(target.fsPath, JSON.stringify(payload, null, 2), "utf8");
    void vscode.window.showInformationMessage(
      `Настройки экспортированы в ${nodePath.basename(target.fsPath)}. Пароли серверов не выгружаются (Keychain) — на новой машине задайте заново.`,
    );
  }

  /** Импорт настроек из JSON: настройки перезаписываются, проекты сливаются по path. */
  async importSettings() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { JSON: ["json"] },
      openLabel: "Импортировать",
    });
    if (!picked?.[0]) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.promises.readFile(picked[0].fsPath, "utf8"));
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Не удалось прочитать JSON: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    await this.serializeMultiMutation(() => this.applyImportedSettings(parsed));
  }

  private async applyImportedSettings(parsed: unknown): Promise<void> {
    // Полный формат {settings: {...}}, старый {projects: [...]} или голый массив проектов.
    const root = parsed as {
      settings?: Record<string, unknown>;
      projects?: unknown;
    };
    const settings = root.settings;
    const cfg = vscode.workspace.getConfiguration("agentHub");
    const g = vscode.ConfigurationTarget.Global;

    if (settings && typeof settings === "object") {
      await this.applySettingsFields(settings);
    }

    const raw = Array.isArray(parsed)
      ? parsed
      : Array.isArray(settings?.projects)
        ? (settings!.projects as unknown[])
        : Array.isArray(root.projects)
          ? (root.projects as unknown[])
          : [];

    const incoming = this.preserveArchivedProjects(normalizeProjects(raw));

    let added = 0;
    let updated = 0;
    if (incoming.length > 0) {
      const list = [...(cfg.get<ProjectInfo[]>("projects", []) ?? [])];
      const existingProjects = this.getAllProjects();
      for (const p of incoming) {
        for (const existing of existingProjects) {
          if (physicalDirectory(existing.path) === physicalDirectory(expandProjectPath(p.path)) &&
              !list.some((entry) => configuredProjectKey(entry) === projectKey(existing))) {
            list.push(existing);
          }
        }
        const idx = list.findIndex((e) => configuredProjectKey(e) === configuredProjectKey(p));
        if (idx >= 0) {
          list[idx] = p;
          updated++;
        } else {
          list.push(p);
          added++;
        }
      }
      await cfg.update("projects", list, g);
    }

    if (!settings && incoming.length === 0) {
      void vscode.window.showErrorMessage(
        "Неверный формат: ожидается объект с полем settings (или projects) либо массив проектов.",
      );
      return;
    }

    this.postFullState();
    await this.postSettings();
    void vscode.window.showInformationMessage(
      `Импорт завершён${settings ? ": настройки применены" : ""}` +
        (incoming.length > 0 ? `; проектов добавлено ${added}, обновлено ${updated}` : "") +
        ". Пароли серверов задаются заново через настройки.",
    );
  }

  /** Команда «задать/сменить пароль сервера» для существующего проекта. */
  async setServerPassword() {
    const projects = this.getProjects();
    if (projects.length === 0) {
      void vscode.window.showWarningMessage("Сначала добавьте проект.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      projects.map((p) => ({ label: p.name, description: p.serverHost ?? p.path, path: projectKey(p) })),
      { placeHolder: "Проект, для которого задать пароль сервера", ignoreFocusOut: true },
    );
    if (!pick) return;

    const password = await vscode.window.showInputBox({
      prompt: `Пароль сервера для «${pick.label}» (пусто — удалить сохранённый)`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return;

    if (password) {
      await this.context.secrets.store(this.passwordKey(pick.path), password);
      void vscode.window.showInformationMessage("Пароль сохранён в защищённом хранилище.");
    } else {
      // Empty override also suppresses older password aliases in project env.
      await this.context.secrets.store(this.passwordKey(pick.path), "");
      void vscode.window.showInformationMessage("Сохранённый пароль удалён.");
    }
  }

  /**
   * Доступы проекта в переменных окружения: значения хранятся в Keychain и
   * попадают ТОЛЬКО в окружение процессов агентов — в чат и промпт идут лишь
   * имена переменных. Для логинов, ключей API, паролей БД и т.п.
   */
  async manageSecretEnv(chatId?: string) {
    const slot = this.findChatSlot(chatId);
    const project = slot
      ? this.getProjects().find((entry) => projectKey(entry) === slot.projectPath)
      : this.getActiveProject();
    if (!project) {
      void vscode.window.showWarningMessage("Сначала добавьте проект.");
      return;
    }
    const key = this.secretEnvKey(projectKey(project));
    for (;;) {
      const env = await this.getSecretEnv(projectKey(project));
      type Item = vscode.QuickPickItem & { name?: string; add?: boolean };
      const items: Item[] = Object.keys(env)
        .sort()
        .map((n) => ({
          label: `$(key) ${n}`,
          description: "значение скрыто · клик — изменить",
          name: n,
          buttons: [{ iconPath: new vscode.ThemeIcon("trash"), tooltip: "Удалить переменную" }],
        }));
      items.push({ label: "$(add) Добавить переменную…", add: true });

      const picked = await new Promise<Item | { removed: string } | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<Item>();
        qp.title = `Доступы в env — «${project.name}»`;
        qp.placeholder =
          "Агент получает их переменными окружения; значения в чат не попадают";
        qp.items = items;
        qp.ignoreFocusOut = true;
        qp.onDidTriggerItemButton((e) => {
          qp.hide();
          resolve(e.item.name ? { removed: e.item.name } : undefined);
        });
        qp.onDidAccept(() => {
          const sel = qp.selectedItems[0];
          qp.hide();
          resolve(sel);
        });
        qp.onDidHide(() => {
          qp.dispose();
          resolve(undefined);
        });
        qp.show();
      });

      if (!picked) return;
      if ("removed" in picked) {
        delete env[picked.removed];
        await this.context.secrets.store(key, JSON.stringify(env));
        await this.postSettings(chatId);
        continue;
      }
      let name = picked.name;
      if (picked.add) {
        name = (
          await vscode.window.showInputBox({
            prompt: "Имя переменной окружения (латиница, цифры, _)",
            placeHolder: "например: DB_PASSWORD, API_KEY, SSH_LOGIN",
            ignoreFocusOut: true,
            validateInput: (v) =>
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim())
                ? undefined
                : "Только латиница, цифры и _, не с цифры",
          })
        )?.trim();
        if (!name) continue;
      }
      if (!name) continue;
      const value = await vscode.window.showInputBox({
        prompt: `Значение ${name} (пусто — отмена). Хранится в защищённом хранилище, в чат не выводится`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!value) continue;
      env[name] = value;
      await this.context.secrets.store(key, JSON.stringify(env));
      await this.postSettings(chatId);
    }
  }

  /**
   * Доступы из сообщения чата → переменные окружения выбранных проектов.
   * Текст разбирается построчно (KEY=value | KEY: value | export KEY=value),
   * агенту НЕ отправляется; в ленту попадают только имена переменных.
   */
  async sendSecretEnvFromMessage(text: string, sourcePath?: string, chatId?: string) {
    const slot = this.findChatSlot(chatId);
    if (chatId && !slot) return;
    sourcePath = slot?.projectPath ?? sourcePath;
    const post = (m: HostToWebview) =>
      sourcePath ? this.postScoped(sourcePath, m as HostToWebview & { path?: string }, chatId) : this.post(m);

    const pairs: Record<string, string> = {};
    const bad: string[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.+)$/);
      if (!m) {
        bad.push(line);
        continue;
      }
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      pairs[m[1]] = v;
    }
    const names = Object.keys(pairs);
    if (names.length === 0) {
      post({
        type: "error",
        message:
          "Не нашёл ни одной пары «ИМЯ=значение». Формат — по строке на переменную: " +
          "SSH_PASSWORD=секрет, API_KEY: значение или export DB_URL=… (# — комментарий).",
      });
      return;
    }

    const projects = this.getProjects();
    if (projects.length === 0) {
      post({ type: "error", message: "Нет проектов — доступы сохранять некуда." });
      return;
    }
    const picked = await vscode.window.showQuickPick(
      projects.map((p) => ({
        label: p.name,
        description: p.serverHost ?? p.path,
        picked: projectKey(p) === (sourcePath ?? this.getActiveProjectKey()),
        path: projectKey(p),
      })),
      {
        canPickMany: true,
        placeHolder: `В env каких проектов сохранить: ${names.join(", ")} (значения в чат не попадут)`,
        ignoreFocusOut: true,
      },
    );
    if (!picked || picked.length === 0) return;

    for (const p of picked) {
      // Picker rows carry the logical key in their path field.
      const env = await this.getSecretEnv(p.path);
      Object.assign(env, pairs);
      await this.context.secrets.store(this.secretEnvKey(p.path), JSON.stringify(env));
    }
    await this.postSettings(chatId);
    // Поле ввода можно очищать только после успешного сохранения.
    if (sourcePath) this.postScoped(sourcePath, { type: "draftHandled" }, chatId);
    else this.post({ type: "draftHandled" });
    post({
      type: "info",
      text:
        `🔐 Сохранено в env (значения скрыты): ${names.join(", ")} → ` +
        `${picked.map((p) => p.label).join(", ")}.` +
        (bad.length ? ` Пропущены строки не по формату: ${bad.length}.` : ""),
    });
  }

  /** Актуальные настройки проекта; значения секретов в контекст не попадают. */
  private async buildProjectCard(p: ProjectInfo, serverEnv?: Record<string, string>): Promise<string> {
    const lines = [`Ты работаешь над проектом «${p.name}».`, `Рабочая папка: ${p.path}`];
    if (p.githubRepo) lines.push(`GitHub-репозиторий проекта: ${p.githubRepo}`);
    if (p.branch) {
      lines.push(
        `Основная рабочая ветка git: ${p.branch}. Работай в ней, если пользователь явно не попросил другую.`,
      );
    }
    if (p.serverHost) {
      const proto = p.serverProtocol ?? "ssh";
      const target = p.serverUser ? `${p.serverUser}@${p.serverHost}` : p.serverHost;
      const env = serverEnv ?? buildServerEnvironment(
        await this.getSecretEnv(projectKey(p)),
        await this.context.secrets.get(this.passwordKey(projectKey(p))),
      );
      const hasPassword = Boolean(env.AGENT_HUB_SERVER_PASSWORD);
      const passwordNote =
        "Текущий пароль передан в SSHPASS, AGENT_HUB_SERVER_PASSWORD и LFTP_PASSWORD. " +
        "sshpass -e читает SSHPASS; lftp --env-password читает LFTP_PASSWORD. " +
        "Не выводи значения в диалог, логи, файлы или аргументы команд. " +
        "Используй окружение текущего процесса, не копируй пароль из старых сообщений или shell-настроек.";

      if (proto === "ssh" || proto === "sftp") {
        try {
          const command = formatSshCommand(
            { host: p.serverHost, user: p.serverUser, protocol: proto, port: p.serverPort },
            hasPassword ? "password" : "key",
            proto === "ssh" ? "<команда>" : undefined,
          );
          lines.push(
            `Сервер проекта: ${proto.toUpperCase()} ${target}${p.serverPort ? `, порт ${p.serverPort}` : ""}.`,
            hasPassword
              ? passwordNote
              : "В этом профиле пароль сервера не задан: SSHPASS, AGENT_HUB_SERVER_PASSWORD и LFTP_PASSWORD пусты. Используй SSH-ключи; не заимствуй пароль из другого проекта, старого диалога или shell-настроек.",
            "Параметры команды совпадают со встроенной проверкой сервера. Сохраняй указанные параметры авторизации при проверке доступа.",
            `Подключение: ${command}`,
          );
          if (proto === "sftp") {
            lines.push("SFTP: батч-команды передавай через stdin (-b -). Shell-доступа может не быть — работай передачей файлов.");
          }
        } catch {
          lines.push("Некорректные настройки SSH/SFTP: команда подключения не сформирована. Проверьте хост, логин и порт.");
        }
      } else {
        const hostPort = `${p.serverHost}${p.serverPort ? `:${p.serverPort}` : ""}`;
        lines.push(`Сервер проекта: FTP ${hostPort}, логин ${p.serverUser ?? "anonymous"}.`);
        lines.push(
          (hasPassword ? `${passwordNote} ` : "") +
            `Подключение: lftp --env-password -u ${p.serverUser ?? "anonymous"} ftp://${hostPort}. ` +
            `Для curl передавай логин и пароль через экранированный конфиг на stdin (-K -), ` +
            `не подставляй пароль в аргументы команд.`,
        );
      }
    }
    if (p.server) lines.push(`Заметки о сервере: ${p.server}`);
    const envNames = Object.keys(await this.getSecretEnv(projectKey(p))).sort();
    if (envNames.length > 0) {
      lines.push(
        `Доступы проекта заданы в переменных окружения: ${envNames.join(", ")}. ` +
          `Бери значения из окружения ($ИМЯ в shell); в текст диалога, логи и файлы их никогда не выводи.`,
      );
    }
    return lines.join("\n");
  }

  // ---------- История сессий (globalState, переживает перезапуски) ----------

  private getStoreAll(): Record<string, ProjectStore> {
    return this.context.globalState.get<Record<string, ProjectStore>>(STORE_KEY, {});
  }

  private async saveProjectStore(projectPath: string, store: ProjectStore) {
    const all = { ...this.getStoreAll() };
    all[projectPath] = store;
    await this.context.globalState.update(STORE_KEY, all);
  }

  private getChatSlots(): ChatSlot[] {
    const projects = new Set(this.getAllProjects().map(projectKey));
    if (!this.chatSlots) {
      const workspace = this.context.workspaceState.get<unknown>(MULTI_CHATS_KEY);
      const legacy = this.context.globalState.get<unknown>(MULTI_CHATS_KEY);
      const saved = Array.isArray(workspace) ? workspace : Array.isArray(legacy) ? legacy : undefined;
      this.multiLayoutInitialized = saved !== undefined;
      this.multiLayoutNeedsMigration = !Array.isArray(workspace) && saved !== undefined;
      this.chatSlots = this.normalizeChatSlots(saved ?? []);
    }
    return this.chatSlots.filter((slot) => projects.has(slot.projectPath));
  }

  /** Panel snapshots are untrusted metadata, never executable work or transcript data. */
  private normalizeChatSlots(values: unknown[]): ChatSlot[] {
    const seen = new Set<string>();
    return values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const slot = value as Partial<ChatSlot>;
      if (typeof slot.chatId !== "string" || !/^chat-[a-z0-9-]{8,80}$/i.test(slot.chatId) ||
          typeof slot.projectPath !== "string" || slot.projectPath.length === 0 ||
          typeof slot.recordId !== "string" || slot.recordId.length === 0 ||
          (slot.agent !== "claude" && slot.agent !== "codex") || seen.has(slot.chatId)) return [];
      seen.add(slot.chatId);
      return [{ chatId: slot.chatId, projectPath: slot.projectPath, recordId: slot.recordId, agent: slot.agent }];
    });
  }

  private async saveChatSlots(slots: ChatSlot[]) {
    // The window's workspace owns its layout; global state only seeds a new workspace.
    const pinKey = `${MULTI_BOARD_KEY_PREFIX}${this.getMultiBoardId()}`;
    const layoutKey = `${MULTI_BOARD_LAYOUT_KEY_PREFIX}${this.getMultiBoardId()}`;
    const previous = this.getChatSlots();
    const previousPins = this.context.globalState.get<unknown>(pinKey);
    const previousLayout = this.context.globalState.get<unknown>(layoutKey);
    const previousWorkspace = this.context.workspaceState.get<unknown>(MULTI_CHATS_KEY);
    // Pin before changing the durable binding so another window cannot prune it in between.
    await this.context.globalState.update(pinKey, [...(Array.isArray(previousPins) ? previousPins : []), ...previous, ...slots]);
    try {
      await this.context.workspaceState.update(MULTI_CHATS_KEY, slots);
      // The exact committed board outranks a browser snapshot saved before the last host ACK.
      await this.context.globalState.update(layoutKey, { version: 1, boardId: this.getMultiBoardId(), chats: slots });
    } catch (error) {
      const rollbacks = await Promise.allSettled([
        this.context.workspaceState.update(MULTI_CHATS_KEY, previousWorkspace),
        this.context.globalState.update(layoutKey, previousLayout),
      ]);
      for (const result of rollbacks) {
        if (result.status === "rejected") console.warn("Agent Hub: could not roll back multichat persistence", result.reason);
      }
      // If either durable binding could still be new, retain the union protecting both.
      if (rollbacks.every((result) => result.status === "fulfilled")) {
        try {
          await this.context.globalState.update(pinKey, previousPins);
        } catch (rollbackError) {
          console.warn("Agent Hub: could not restore multichat session references", rollbackError);
        }
      }
      throw error;
    }
    this.chatSlots = slots;
    this.multiLayoutInitialized = true;
    this.multiLayoutNeedsMigration = false;
    this.multiLayoutPinned = true;
    try {
      await this.context.globalState.update(pinKey, slots);
    } catch (error) {
      // The earlier union safely retains both layouts if cleanup fails.
      console.warn("Agent Hub: could not trim multichat session references", error);
    }
    try {
      await this.context.globalState.update(MULTI_CHATS_KEY, slots);
    } catch (error) {
      console.warn("Agent Hub: could not update the fallback multichat layout", error);
    }
  }

  private getMultiBoardId(): string {
    return this.multiBoardId ??= `board-${randomUUID()}`;
  }

  /** Closed workspaces still own their records, including empty chats with model overrides. */
  private savedBoardRecordIds(projectPath: string): Set<string> {
    const records = new Set(this.getChatSlots().filter((slot) => slot.projectPath === projectPath).map((slot) => slot.recordId));
    for (const key of this.context.globalState.keys()) {
      if (!key.startsWith(MULTI_BOARD_KEY_PREFIX)) continue;
      const slots = this.context.globalState.get<unknown>(key);
      if (!Array.isArray(slots)) continue;
      // A pending write pins two records under the same chatId until its workspace commit.
      for (const value of slots) {
        const [slot] = this.normalizeChatSlots([value]);
        if (slot?.projectPath === projectPath) records.add(slot.recordId);
      }
    }
    return records;
  }

  /** Only an explicit history deletion proves an old board reference may be discarded. */
  private async forgetSavedBoardRecord(projectPath: string, recordId: string) {
    for (const key of this.context.globalState.keys()) {
      if (!key.startsWith(MULTI_BOARD_KEY_PREFIX)) continue;
      const slots = this.context.globalState.get<unknown>(key);
      if (!Array.isArray(slots)) continue;
      const remaining = slots.filter((value: unknown) => !value || typeof value !== "object" ||
        (value as Partial<ChatSlot>).projectPath !== projectPath || (value as Partial<ChatSlot>).recordId !== recordId);
      if (remaining.length === slots.length) continue;
      try {
        await this.context.globalState.update(key, remaining.length ? remaining : undefined);
      } catch (error) {
        console.warn("Agent Hub: could not clear a deleted multichat session reference", error);
      }
    }
  }

  /** Serialize layout read/modify/write operations, preserving the order of user clicks. */
  private serializeMultiMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = (this.multiMutation ?? Promise.resolve()).then(operation);
    this.multiMutation = pending.then(() => {}, () => {});
    return pending;
  }

  private findChatSlot(chatId: string | undefined): ChatSlot | undefined {
    return chatId ? this.getChatSlots().find((slot) => slot.chatId === chatId) : undefined;
  }

  private chatDescriptor(slot: ChatSlot) {
    const record = this.getProjectStore(slot.projectPath).sessions.find((entry) => entry.id === slot.recordId);
    return { ...slot, title: record?.title ?? "Новая сессия" };
  }

  private postMultiBoardState() {
    if (!this.multiPanel) return;
    this.multiPanel.webview.postMessage({
      type: "multiState",
      boardId: this.getMultiBoardId(),
      projects: this.getProjects(),
      archivedProjects: this.getArchivedProjects(),
      chats: this.getChatSlots().map((slot) => this.chatDescriptor(slot)),
    } satisfies HostToWebview);
  }

  private async postMultiState(onlyChatId?: string) {
    if (!this.multiPanel) return;
    // Publish bindings before their transcripts so tiles can reject stale hydration.
    this.postMultiBoardState();
    this.postRuntimeSettings();
    const projects = this.getProjects();
    const archivedProjects = this.getArchivedProjects();
    const activeKeys = new Set(projects.map(projectKey));
    for (const slot of this.getChatSlots().filter((entry) => (!onlyChatId || entry.chatId === onlyChatId) && activeKeys.has(entry.projectPath))) {
      const record = this.getProjectStore(slot.projectPath).sessions.find((entry) => entry.id === slot.recordId);
      if (!record) continue;
      this.postScoped(slot.projectPath, { type: "projects", projects, archivedProjects, activePath: slot.projectPath }, slot.chatId);
      this.postScoped(slot.projectPath, { type: "transcript", path: slot.projectPath, items: record.items, recordId: record.id }, slot.chatId);
      this.postScoped(slot.projectPath, { type: "busy", value: this.runs.has(slot.chatId) }, slot.chatId);
      for (const agent of ["claude", "codex"] as const) {
        this.postScoped(slot.projectPath, { type: "sessionInfo", sessionId: record.agentIds[agent], agent }, slot.chatId);
        const ctx = record.context?.[agent];
        this.postScoped(slot.projectPath, { type: "contextUsage", agent, used: ctx?.used ?? 0, max: ctx?.max ?? 0 }, slot.chatId);
        this.postRecordModel(slot.projectPath, record, agent, slot.chatId);
      }
    }
  }

  private async openMultiChat() {
    if (this.multiPanel) {
      this.multiPanel.reveal();
      this.postRuntimeSettings();
      this.postMultiModels();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.multiViewId,
      "Agent Hub — мультичат",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")] },
    );
    this.attachMultiChatPanel(panel);
    await this.ensureMultiChats();
  }

  /** VS Code supplies the original tab and its own snapshot, even in a shared workspace. */
  async restoreMultiChatPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    await this.serializeMultiMutation(async () => {
      if (this.multiPanel === panel) return;
      if (this.multiPanel) {
        panel.dispose();
        this.multiPanel.reveal();
        return;
      }
      if (state && typeof state === "object" &&
          (state as { version?: unknown }).version === 1 &&
          Array.isArray((state as { chats?: unknown }).chats)) {
        const previousBoardId = this.multiBoardId;
        const boardId = (state as { boardId?: unknown }).boardId;
        if (typeof boardId === "string" && /^board-[a-z0-9-]{8,80}$/i.test(boardId)) this.multiBoardId = boardId;
        const committed = this.multiBoardId
          ? this.context.globalState.get<{ version?: unknown; boardId?: unknown; chats?: unknown }>(`${MULTI_BOARD_LAYOUT_KEY_PREFIX}${this.multiBoardId}`)
          : undefined;
        const saved = committed && committed.version === 1 && committed.boardId === this.multiBoardId && Array.isArray(committed.chats)
          ? committed.chats : (state as { chats: unknown[] }).chats;
        const projects = new Set(this.getAllProjects().map(projectKey));
        const slots = this.normalizeChatSlots(saved)
          .filter((slot) => projects.has(slot.projectPath));
        try {
          await this.saveChatSlots(slots);
        } catch (error) {
          // A later manual open must not claim the unsuccessfully restored tab's identity.
          this.multiBoardId = previousBoardId;
          throw error;
        }
      }
      this.attachMultiChatPanel(panel);
      await this.ensureMultiChats();
    });
  }

  private attachMultiChatPanel(panel: vscode.WebviewPanel) {
    this.multiPanel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg");
    const messages = panel.webview.onDidReceiveMessage((msg: WebviewToHost) =>
      this.onMessage(msg, "vscode", undefined, "multi-panel"),
    );
    const disposed = panel.onDidDispose(() => {
      messages.dispose();
      disposed.dispose();
      if (this.multiPanel === panel) this.multiPanel = null;
    });
    panel.webview.html = this.renderHtml(panel.webview, "multi-panel");
  }

  private async createMultiChat(projectPath?: string) {
    const slot = await this.createChatSlot(projectPath);
    if (!slot) {
      this.multiPanel?.webview.postMessage({ type: "error", message: "Сначала добавьте или выберите проект." });
      return;
    }
    this.postMultiBoardState();
  }

  private async removeMultiChat(chatId: string) {
    this.runs.get(chatId)?.abort();
    this.denyAllPending(undefined, chatId);
    await this.saveChatSlots(this.getChatSlots().filter((slot) => slot.chatId !== chatId));
    this.postMultiBoardState();
  }

  private async selectMultiChatProject(chatId: string, projectPath: string) {
    const slot = this.findChatSlot(chatId);
    const project = this.getProjects().find((entry) => projectKey(entry) === projectPath);
    if (!slot) return;
    const reject = (message: string) => {
      const actual = this.findChatSlot(chatId);
      if (!actual) return;
      this.postScoped(actual.projectPath, { type: "chatProjectRejected", chatId,
        requestedProjectPath: projectPath, projectPath: actual.projectPath,
        recordId: actual.recordId, agent: actual.agent, message }, chatId);
    };
    if (!project || this.runs.has(chatId)) {
      reject(!project ? "Проект больше недоступен." : "Дождитесь завершения хода или остановите его перед сменой проекта.");
      return;
    }
    try {
      if (slot.projectPath !== projectPath) {
        const store = this.getProjectStore(projectPath);
        const record = this.createRecord();
        const previous = this.getProjectStore(slot.projectPath).sessions.find((entry) => entry.id === slot.recordId);
        record.modelOverrides = { ...previous?.modelOverrides };
        store.sessions.push(record);
        await this.saveProjectStore(projectPath, store);
        await this.saveChatSlots(this.getChatSlots().map((entry) => entry.chatId === chatId
          ? { ...entry, projectPath, recordId: record.id } : entry));
      }
      await this.postMultiState(chatId);
    } catch {
      reject("Не удалось сохранить выбор проекта. Повторите переключение.");
      await this.postMultiState(chatId);
    }
  }

  private async selectMultiChatSession(chatId: string, recordId: string) {
    const slot = this.findChatSlot(chatId);
    if (!slot || this.runs.has(chatId) || !this.getProjectStore(slot.projectPath).sessions.some((record) => record.id === recordId)) return;
    await this.saveChatSlots(this.getChatSlots().map((entry) => entry.chatId === chatId
      ? { ...entry, recordId } : entry));
    await this.postMultiState(chatId);
  }

  private async selectMultiChatAgent(chatId: string, agent: AgentId) {
    const slot = this.findChatSlot(chatId);
    if (!slot) return;
    try {
      await this.saveChatSlots(this.getChatSlots().map((entry) => entry.chatId === chatId
        ? { ...entry, agent } : entry));
      await this.context.globalState.update(MULTI_PREFERRED_AGENT_KEY, agent);
    } catch {
      this.postScoped(slot.projectPath, { type: "error", message: "Не удалось сохранить выбор провайдера для следующего открытия." }, chatId);
    } finally {
      await this.postMultiState(chatId);
    }
  }

  private async createChatSlot(projectPath?: string): Promise<ChatSlot | null> {
    const project = projectPath
      ? this.getProjects().find((entry) => projectKey(entry) === projectPath)
      : this.getActiveProject();
    if (!project) return null;
    const key = projectKey(project);
    const store = this.getProjectStore(key);
    const record = this.createRecord();
    store.sessions.push(record);
    await this.saveProjectStore(key, store);
    const slot: ChatSlot = {
      chatId: `chat-${randomUUID()}`,
      projectPath: key,
      recordId: record.id,
      agent: this.preferredMultiAgent(),
    };
    await this.saveChatSlots([...this.getChatSlots(), slot]);
    return slot;
  }

  private async ensureMultiChats() {
    if (this.multiInit) return this.multiInit;
    this.multiInit = this.initializeMultiChats();
    try {
      await this.multiInit;
    } finally {
      this.multiInit = undefined;
    }
  }

  private async initializeMultiChats() {
    let slots = this.getChatSlots();
    if (!this.multiLayoutInitialized) {
      const project = this.getActiveProject() ?? this.getProjects()[0];
      if (!project) return;
      const key = projectKey(project);
      const store = this.getProjectStore(key);
      const created: ChatSlot[] = [];
      for (let i = 0; i < 4; i++) {
        const record = this.createRecord();
        store.sessions.push(record);
        created.push({ chatId: `chat-${randomUUID()}`, projectPath: key, recordId: record.id, agent: this.preferredMultiAgent() });
      }
      await this.saveProjectStore(key, store);
      await this.saveChatSlots(created);
      slots = created;
    }
    if (this.multiLayoutNeedsMigration || !this.multiLayoutPinned) await this.saveChatSlots(slots);
    // Old versions could prune an empty record while its tile still existed.
    // Restore those tiles with fresh sessions instead of silently closing them.
    let repaired = false;
    for (const slot of slots) {
      const store = this.getProjectStore(slot.projectPath);
      if (store.sessions.some((record) => record.id === slot.recordId)) continue;
      const record = this.createRecord();
      store.sessions.push(record);
      await this.saveProjectStore(slot.projectPath, store);
      slot.recordId = record.id;
      repaired = true;
    }
    if (repaired) await this.saveChatSlots(slots);
    await this.postMultiState();
  }

  private preferredMultiAgent(): AgentId {
    return this.context.globalState.get<string>(MULTI_PREFERRED_AGENT_KEY) === "codex" ? "codex" : "claude";
  }

  private selectedModel(record: SessionRecord | null | undefined, agent: AgentId): string {
    return record?.modelOverrides?.[agent] || vscode.workspace.getConfiguration(`agentHub.${agent}`).get<string>("model", "") || "";
  }

  private postRecordModel(projectPath: string, record: SessionRecord | null | undefined, agent: AgentId, chatId?: string) {
    const fallbackFrom = record?.modelFallbacks?.[agent];
    const model = fallbackFrom && record?.models?.[agent]
      ? record.models[agent]!
      : this.selectedModel(record, agent) || record?.models?.[agent] || (agent === "codex" ? codexDefaultModel() ?? "" : "");
    this.postScoped(projectPath, { type: "modelInfo", agent, model, ...(fallbackFrom ? { fallbackFrom } : {}) }, chatId);
  }

  private postMultiModels() {
    for (const slot of this.getChatSlots()) {
      const record = this.getProjectStore(slot.projectPath).sessions.find((entry) => entry.id === slot.recordId);
      for (const agent of ["claude", "codex"] as const) this.postRecordModel(slot.projectPath, record, agent, slot.chatId);
    }
  }

  /** Global runtime choices must also reach newly mounted tiles and a reopened board. */
  private postRuntimeSettings() {
    this.post({ type: "autoScrollMode", mode: vscode.workspace.getConfiguration("agentHub").get<string>("autoScrollMode", "perProject") });
    this.postSafety();
    this.postEfforts();
    this.postSlashCommands();
  }

  /** Хранилище проекта; при первом обращении мигрирует данные v0.0.2–0.0.3. */
  private getProjectStore(projectPath: string): ProjectStore {
    const existing = this.getStoreAll()[projectPath];
    if (existing) return existing;

    const legacyItems =
      this.context.globalState.get<Record<string, unknown[]>>(LEGACY_TRANSCRIPTS_KEY, {})[
        projectPath
      ] ?? [];
    const legacyIds = this.context.globalState.get<Record<string, ProjectSessions>>(
      LEGACY_SESSIONS_KEY,
      {},
    )[projectPath];
    if (legacyItems.length > 0 || legacyIds) {
      const rec = this.createRecord(legacyItems, legacyIds ?? { claude: null, codex: null });
      const store: ProjectStore = { activeId: rec.id, sessions: [rec] };
      void this.saveProjectStore(projectPath, store);
      return store;
    }
    return { activeId: null, sessions: [] };
  }

  private createRecord(
    items: unknown[] = [],
    agentIds: ProjectSessions = { claude: null, codex: null },
  ): SessionRecord {
    return {
      id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: deriveTitle(items) ?? "Новая сессия",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agentIds,
      items,
    };
  }

  private getActiveRecord(projectPath: string): SessionRecord | null {
    const store = this.getProjectStore(projectPath);
    return store.sessions.find((s) => s.id === store.activeId) ?? null;
  }

  /** Активная запись; создаётся при первом сообщении. */
  private async ensureActiveRecord(projectPath: string): Promise<SessionRecord> {
    const store = this.getProjectStore(projectPath);
    let rec = store.sessions.find((s) => s.id === store.activeId) ?? null;
    if (!rec) {
      rec = this.createRecord();
      store.sessions.push(rec);
      store.activeId = rec.id;
      await this.saveProjectStore(projectPath, store);
    }
    return rec;
  }

  /** Выкинуть из истории пустые сессии (кроме активной). */
  private pruneEmptySessions(store: ProjectStore, projectPath: string) {
    const displayed = this.savedBoardRecordIds(projectPath);
    store.sessions = store.sessions.filter(
      (s) => s.id === store.activeId || displayed.has(s.id) || hasUserContent(s.items),
    );
  }

  private async mutateActiveRecord(projectPath: string, fn: (rec: SessionRecord) => void) {
    const store = this.getProjectStore(projectPath);
    const rec = store.sessions.find((s) => s.id === store.activeId);
    if (!rec) return;
    fn(rec);
    rec.updatedAt = Date.now();
    await this.saveProjectStore(projectPath, store);
  }

  /** Мутация конкретной записи по id — не «активной»: пока ход шёл, пользователь
   *  мог переключить сессию, а данные хода принадлежат записи, где он начался. */
  private async mutateRecord(
    projectPath: string,
    recordId: string,
    fn: (rec: SessionRecord) => void,
  ) {
    const store = this.getProjectStore(projectPath);
    const rec = store.sessions.find((s) => s.id === recordId);
    if (!rec) return;
    fn(rec);
    rec.updatedAt = Date.now();
    await this.saveProjectStore(projectPath, store);
  }

  /** Полное состояние для webview: проекты, лента активной сессии, session id. */
  private postFullState() {
    const projects = this.getProjects();
    const active = this.getActiveProject();
    this.post({ type: "projects", projects, archivedProjects: this.getArchivedProjects(), activePath: active ? projectKey(active) : "" });
    if (active) {
      const rec = this.getActiveRecord(projectKey(active));
      this.post({ type: "transcript", path: projectKey(active), items: rec?.items ?? [] });
      // Скоуп обязателен: burst идёт до ре-рендера webview, и фолбэк на
      // activeRef разложил бы состояние под старым проектом (баг из ревью).
      this.postScoped(projectKey(active), {
        type: "sessionInfo",
        sessionId: rec?.agentIds.claude ?? null,
        agent: "claude",
      });
      this.postScoped(projectKey(active), {
        type: "sessionInfo",
        sessionId: rec?.agentIds.codex ?? null,
        agent: "codex",
      });
      for (const a of ["claude", "codex"] as const) {
        const ctx = rec?.context?.[a];
        this.postScoped(projectKey(active), {
          type: "contextUsage",
          agent: a,
          used: ctx?.used ?? 0,
          max: ctx?.max ?? 0,
        });
        this.postRecordModel(projectKey(active), rec, a);
      }
    }
    this.postRuntimeSettings();
    if (this.multiPanel) void this.postMultiState();
  }

  /** Настройки агента (модель, effort и т.п.) из VS Code settings. */
  private buildAgentConfig(
    agent: AgentId,
    modelOverride?: string,
  ): import("./agents/types").AgentRunConfig {
    const cfg = vscode.workspace.getConfiguration(`agentHub.${agent}`);
    if (agent === "claude") {
      const cw = cfg.get<number>("contextWindow", 0);
      return {
        model: modelOverride || cfg.get<string>("model") || undefined,
        effort: cfg.get<string>("effort") || undefined,
        permissionMode: cfg.get<string>("permissionMode") || "default",
        maxTurns: cfg.get<number>("maxTurns") || 0,
        // 200000 — старый дефолт до v0.0.14, трактуем как «авто по модели».
        contextWindow: cw === 200000 ? 0 : cw,
      };
    }
    const cw = cfg.get<number>("contextWindow", 0);
    return {
      model: modelOverride || cfg.get<string>("model") || undefined,
      effort: cfg.get<string>("effort") || undefined,
      sandbox: cfg.get<string>("sandbox") || "workspace-write",
      yolo: cfg.get<boolean>("yolo") || false,
      contextWindow: cw === 400000 ? 0 : cw,
    };
  }

  // ---------- Настройки внутри панели ----------

  private async buildSettingsSnapshot(chatId?: string): Promise<import("./shared/protocol").SettingsSnapshot> {
    const cfg = vscode.workspace.getConfiguration("agentHub");
    const slot = this.findChatSlot(chatId);
    const project = chatId
      ? this.getProjects().find((entry) => projectKey(entry) === slot?.projectPath) ?? null
      : this.getActiveProject();
    const hasPassword = project ? Boolean(buildServerEnvironment(
      await this.getSecretEnv(projectKey(project)),
      await this.context.secrets.get(this.passwordKey(projectKey(project))),
    ).AGENT_HUB_SERVER_PASSWORD) : false;
    return {
      claude: {
        model: cfg.get<string>("claude.model", ""),
        effort: cfg.get<string>("claude.effort", ""),
        permissionMode: cfg.get<string>("claude.permissionMode", "default"),
        maxTurns: cfg.get<number>("claude.maxTurns", 0),
        contextWindow: cfg.get<number>("claude.contextWindow", 0) === 200000 ? 0 : cfg.get<number>("claude.contextWindow", 0),
      },
      codex: {
        model: cfg.get<string>("codex.model", ""),
        effort: cfg.get<string>("codex.effort", ""),
        sandbox: cfg.get<string>("codex.sandbox", "workspace-write"),
        yolo: cfg.get<boolean>("codex.yolo", false),
        contextWindow: cfg.get<number>("codex.contextWindow", 0) === 400000 ? 0 : cfg.get<number>("codex.contextWindow", 0),
      },
      journalDir: cfg.get<string>("journalDir", "docs/journal"),
      journalContextEntries: cfg.get<number>("journalContextEntries", 3),
      autoAllowTools: cfg.get<string[]>("autoAllowTools", []),
      autoAllowBash: cfg.get<string[]>("autoAllowBash", []),
      autoCommit: cfg.get<boolean>("autoCommit", true),
      autoPush: cfg.get<boolean>("autoPush", false),
      autoPull: cfg.get<boolean>("autoPull", true),
      autoScrollMode: cfg.get<string>("autoScrollMode", "perProject"),
      project,
      projectHasPassword: hasPassword,
      secretEnvNames: project ? Object.keys(await this.getSecretEnv(projectKey(project))).sort() : [],
    };
  }

  private async postSettings(chatId?: string) {
    const slot = this.findChatSlot(chatId);
    if (chatId && !slot) return;
    const settings = await this.buildSettingsSnapshot(chatId);
    if (slot && this.findChatSlot(chatId)?.projectPath !== slot.projectPath) return;
    const emit = (message: HostToWebview) => slot
      ? this.postScoped(slot.projectPath, message, chatId) : this.post(message);
    emit({ type: "settings", settings });
    emit({
      type: "configJson",
      json: JSON.stringify(this.collectAllSettings(), null, 2),
    });
  }

  private async applySettings(s: import("./shared/protocol").SettingsSave, chatId?: string, serialized = false): Promise<void> {
    if (!serialized) return this.serializeMultiMutation(() => this.applySettings(s, chatId, true));
    const slot = this.findChatSlot(chatId);
    if (chatId && (!slot || (s.project && configuredProjectKey(s.project) !== slot.projectPath))) return;
    const cfg = vscode.workspace.getConfiguration("agentHub");
    const g = vscode.ConfigurationTarget.Global;
    await cfg.update("claude.model", s.claude.model, g);
    await cfg.update("claude.effort", s.claude.effort, g);
    await cfg.update("claude.permissionMode", s.claude.permissionMode, g);
    await cfg.update("claude.maxTurns", s.claude.maxTurns, g);
    await cfg.update("claude.contextWindow", s.claude.contextWindow, g);
    await cfg.update("codex.model", s.codex.model, g);
    await cfg.update("codex.effort", s.codex.effort, g);
    await cfg.update("codex.sandbox", s.codex.sandbox, g);
    await cfg.update("codex.yolo", s.codex.yolo, g);
    await cfg.update("codex.contextWindow", s.codex.contextWindow, g);
    await cfg.update("journalDir", s.journalDir, g);
    await cfg.update("journalContextEntries", s.journalContextEntries, g);
    await cfg.update("autoAllowTools", s.autoAllowTools, g);
    await cfg.update("autoAllowBash", s.autoAllowBash, g);
    await cfg.update("autoCommit", s.autoCommit, g);
    await cfg.update("autoPush", s.autoPush, g);
    await cfg.update("autoPull", s.autoPull, g);
    await cfg.update("autoScrollMode", s.autoScrollMode, g);

    if (s.project) {
      const list = [...(cfg.get<ProjectInfo[]>("projects", []) ?? [])];
      const idx = list.findIndex(
        (p) => configuredProjectKey(p) === configuredProjectKey(s.project!),
      );
      const entry = this.preserveProjectArchiveState({
        ...s.project,
        name: s.project.name || nodePath.basename(s.project.path),
      });
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      await cfg.update("projects", list, g);

      if (s.newPassword !== undefined) {
        if (s.newPassword) {
          await this.context.secrets.store(this.passwordKey(configuredProjectKey(s.project)), s.newPassword);
        } else {
          // Preserve the explicit removal across turns instead of reviving an env alias.
          await this.context.secrets.store(this.passwordKey(configuredProjectKey(s.project)), "");
        }
      }
    }

    this.postFullState();
    await this.postSettings(chatId);
    if (slot) this.postScoped(slot.projectPath, { type: "info", text: "Настройки сохранены." }, chatId);
    else this.post({ type: "info", text: "Настройки сохранены." });
  }

  // ---------- Быстрый переключатель разрешений (YOLO) ----------

  private getSafetyInfo(agent: AgentId): { label: string; dangerous: boolean } {
    if (agent === "claude") {
      const mode = vscode.workspace
        .getConfiguration("agentHub.claude")
        .get<string>("permissionMode", "default");
      if (mode === "bypassPermissions") return { label: "⚠️ YOLO", dangerous: true };
      if (mode === "acceptEdits") return { label: "✏️ правки без спроса", dangerous: false };
      return { label: "🔒 подтверждения", dangerous: false };
    }
    const c = vscode.workspace.getConfiguration("agentHub.codex");
    if (c.get<boolean>("yolo", false)) return { label: "⚠️ YOLO", dangerous: true };
    return { label: `🔒 ${c.get<string>("sandbox", "workspace-write")}`, dangerous: false };
  }

  private postSafety() {
    for (const a of ["claude", "codex"] as const) {
      const s = this.getSafetyInfo(a);
      this.post({ type: "safetyInfo", agent: a, label: s.label, dangerous: s.dangerous });
    }
  }

  /**
   * Быстрый выбор модели по клику на бейдж. Применяется со следующего хода —
   * в т.ч. чтобы вернуться на основную модель после «липкого» фоллбэка.
   */
  async pickModel(agent: AgentId, remote?: RemoteClient, chatId?: string) {
    const section = vscode.workspace.getConfiguration(`agentHub.${agent}`);
    const slot = this.findChatSlot(chatId);
    const record = slot ? this.getProjectStore(slot.projectPath).sessions.find((entry) => entry.id === slot.recordId) : null;
    const current = this.selectedModel(record, agent);
    const CUSTOM = "__custom__";
    const REFRESH = "__refresh__";

    type Item = vscode.QuickPickItem & { value: string };
    const base: Item[] =
      agent === "claude"
        ? [
            { label: "По умолчанию CLI", detail: "модель из настроек claude", value: "" },
            // Актуальный список из самого CLI (supportedModels, кэшируется
            // после первого хода); до первого хода — запасной статический.
            ...this.listClaudeModels().map((m) => ({
              label: m.value,
              detail:
                [
                  m.displayName && m.displayName !== m.value ? m.displayName : undefined,
                  m.description,
                ]
                  .filter(Boolean)
                  .join(" — ") || undefined,
              value: m.value,
            })),
            { label: "$(sync) Обновить список из Claude Code", value: REFRESH },
            { label: "$(edit) Ввести вручную…", value: CUSTOM },
          ]
        : [
            { label: "По умолчанию", detail: "модель из ~/.codex/config.toml", value: "" },
            // Список из кэша самого CLI — актуальные модели аккаунта.
            ...this.listCodexModels().map((m) => ({
              label: m.slug,
              detail: m.description,
              value: m.slug,
            })),
            { label: "$(edit) Ввести вручную…", value: CUSTOM },
          ];

    if (remote) {
      remote.send({
        type: "choices",
        kind: "model",
        agent,
        title: `Модель для ${agent === "claude" ? "Claude" : "Codex"}`,
        items: base
          .filter((i) => i.value !== CUSTOM && i.value !== REFRESH)
          .map((i) => ({ label: i.label, detail: i.detail, value: i.value, current: i.value === current })),
      });
      return;
    }

    const pick = await vscode.window.showQuickPick(
      base.map((i) => ({
        ...i,
        description: i.value === current ? "✓ текущая настройка" : undefined,
      })),
      {
        placeHolder: `Модель для ${agent === "claude" ? "Claude" : "Codex"} — применится со следующего хода`,
        ignoreFocusOut: true,
      },
    );
    if (!pick) return;

    if (pick.value === REFRESH) {
      // Сброс кэша: следующий ход Claude перезапросит модели у CLI.
      await this.context.globalState.update(CLAUDE_MODELS_KEY, undefined);
      await this.context.globalState.update(CLAUDE_MODELS_AT_KEY, 0);
      const cli = this.resolveClaudeCli();
      this.post({
        type: "info",
        text:
          "Список моделей обновится при следующем ходе Claude " +
          (cli ? `(CLI: ${cli}).` : "(Claude Code, встроенный в плагин; чтобы брать модели из установленного claude — настройка agentHub.claude.cliPath = auto)."),
      });
      return;
    }
    let value = pick.value;
    if (value === CUSTOM) {
      const input = await vscode.window.showInputBox({
        prompt: "Идентификатор модели",
        value: current,
        placeHolder: agent === "claude" ? "например: claude-fable-5" : "например: gpt-5-codex",
        ignoreFocusOut: true,
      });
      if (input === undefined) return;
      value = input.trim();
    }

    // Область действия: только текущий чат или базовая (для всех новых чатов).
    const agentName = agent === "claude" ? "Claude" : "Codex";
    const scope = await vscode.window.showQuickPick(
      [
        {
          label: "Только этот чат",
          description: chatId ? "сохранится в этой плитке при новой сессии и смене проекта" : "новый чат начнётся с базовой модели",
          base: false,
        },
        {
          label: "Базовая — по умолчанию для новых чатов",
          description: "сохранится в настройках",
          base: true,
        },
      ],
      {
        placeHolder: `Где применять: ${value || "модель по умолчанию CLI"}`,
        ignoreFocusOut: true,
      },
    );
    if (!scope) return;
    await this.applyModel(agent, value, scope.base, chatId);
  }

  /** Применить выбор модели: только в этот чат или как базовую для новых. */
  async applyModel(agent: AgentId, value: string, base: boolean, chatId?: string, serialized = false): Promise<void> {
    if (!serialized) return this.serializeMultiMutation(() => this.applyModel(agent, value, base, chatId, true));
    const section = vscode.workspace.getConfiguration(`agentHub.${agent}`);
    const agentName = agent === "claude" ? "Claude" : "Codex";
    const slot = this.findChatSlot(chatId);
    if (chatId && !slot) return;
    const project = slot
      ? this.getProjects().find((entry) => projectKey(entry) === slot.projectPath)
      : this.getActiveProject();
    const record = project ? slot
      ? this.getProjectStore(slot.projectPath).sessions.find((entry) => entry.id === slot.recordId)
      : await this.ensureActiveRecord(projectKey(project)) : null;
    const updateRecord = async (mutate: (record: SessionRecord) => void) => {
      if (!project || !record) return;
      await this.mutateRecord(projectKey(project), record.id, (current) => {
        mutate(current);
        if (current.models) delete current.models[agent];
        if (current.modelFallbacks) delete current.modelFallbacks[agent];
      });
    };
    const emit = (message: HostToWebview) => slot ? this.postScoped(slot.projectPath, message, chatId) : this.post(message);
    if (base) {
      await section.update("model", value, vscode.ConfigurationTarget.Global);
      // Базовая изменилась — текущий чат следует ей, свой выбор снимаем.
      await updateRecord((current) => { if (current.modelOverrides) delete current.modelOverrides[agent]; });
      for (const following of this.getChatSlots()) {
        const current = this.getProjectStore(following.projectPath).sessions.find((entry) => entry.id === following.recordId);
        if (!current || current.modelOverrides?.[agent]) continue;
        await this.mutateRecord(following.projectPath, current.id, (entry) => {
          if (entry.models) delete entry.models[agent];
          if (entry.modelFallbacks) delete entry.modelFallbacks[agent];
        });
      }
      emit({
        type: "info",
        text: value
          ? `Базовая модель ${agentName} (новые чаты и этот): ${value}.`
          : `Базовая модель ${agentName}: по умолчанию CLI.`,
      });
    } else {
      if (!project) return;
      await updateRecord((r) => {
        const o = (r.modelOverrides ??= {});
        if (value) o[agent] = value;
        else delete o[agent];
      });
      const baseModel = section.get<string>("model", "") || "по умолчанию CLI";
      emit({
        type: "info",
        text: value
          ? chatId
            ? `Модель ${agentName} для этой плитки: ${value}. Выбор сохранится при новой сессии и смене проекта.`
            : `Модель ${agentName} для ЭТОГО чата: ${value}. Новый чат начнётся с базовой (${baseModel}).`
          : `Свой выбор модели ${agentName} в этом чате снят — действует базовая (${baseModel}).`,
      });
    }
    if (project && record) this.postRecordModel(projectKey(project), record, agent, chatId);
    if (base) this.postMultiModels();
    await this.postSettings(chatId);
  }

  /** Кэш моделей Claude устарел (или пуст) — пора перезапросить у CLI. */
  private claudeModelsStale(): boolean {
    const at = this.context.globalState.get<number>(CLAUDE_MODELS_AT_KEY, 0);
    return Date.now() - at > CLAUDE_MODELS_TTL_MS;
  }

  /**
   * Какой claude запускать: пусто — встроенный в SDK плагина; «auto» — тот,
   * что установлен в системе (PATH и типовые места); иначе — заданный путь.
   */
  private resolveClaudeCli(): string | undefined {
    const setting = vscode.workspace
      .getConfiguration("agentHub.claude")
      .get<string>("cliPath", "")
      .trim();
    if (!setting) return undefined;
    const exists = (p: string) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    };
    if (setting !== "auto") {
      const p = setting.replace(/^~(?=\/|$)/, os.homedir());
      return exists(p) ? p : undefined;
    }
    const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
    const dirs = [
      ...(process.env.PATH ?? "").split(nodePath.delimiter),
      nodePath.join(os.homedir(), ".local", "bin"),
      nodePath.join(os.homedir(), ".claude", "local"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];
    for (const d of dirs) {
      if (!d) continue;
      for (const n of names) {
        const p = nodePath.join(d, n);
        if (exists(p)) return p;
      }
    }
    return undefined;
  }

  /** Модели Claude: кэш supportedModels CLI; до первого хода — статический список. */
  private listClaudeModels(): ClaudeModelInfo[] {
    const cached = this.context.globalState.get<ClaudeModelInfo[]>(CLAUDE_MODELS_KEY, []);
    if (cached.length > 0) return cached;
    return [
      { value: "claude-fable-5-1", description: "новейшая, максимальные способности" },
      { value: "claude-opus-5-5", description: "новый Opus" },
      { value: "claude-fable-5", description: "максимальные способности" },
      { value: "claude-opus-5", description: "топ для агентной работы" },
      { value: "claude-opus-4-8" },
      { value: "claude-sonnet-5", description: "быстрее и дешевле" },
      { value: "claude-haiku-4-5", description: "самый быстрый" },
    ];
  }

  /** Текущий effort обоих агентов — для кнопки в статус-баре чата. */
  private postEfforts() {
    for (const a of ["claude", "codex"] as const) {
      this.post({
        type: "effortInfo",
        agent: a,
        effort: vscode.workspace.getConfiguration(`agentHub.${a}`).get<string>("effort", ""),
      });
    }
  }

  /** Быстрый выбор effort (глубины размышлений) по клику в статус-баре. */
  async pickEffort(agent: AgentId, remote?: RemoteClient, chatId?: string) {
    const section = vscode.workspace.getConfiguration(`agentHub.${agent}`);
    const current = section.get<string>("effort", "");
    const slot = this.findChatSlot(chatId);
    if (chatId && !slot) return;
    const record = slot ? this.getProjectStore(slot.projectPath).sessions.find((entry) => entry.id === slot.recordId) : null;
    type Item = vscode.QuickPickItem & { value: string };
    let base: Item[];
    let subject = "Claude";
    if (agent === "claude") {
      // Уровни effort выбранной модели — из supportedModels CLI (кэш);
      // модель не выбрана или неизвестна — полный набор SDK.
      const model = this.selectedModel(record, agent);
      const info = model ? this.listClaudeModels().find((m) => m.value === model) : undefined;
      const levels = info?.supportedEffortLevels?.length
        ? info.supportedEffortLevels
        : ["low", "medium", "high", "xhigh", "max"];
      const hints: Record<string, string> = {
        low: "быстрые ответы, лёгкие размышления",
        medium: "баланс скорости и глубины",
        high: "глубже — для сложных задач",
        xhigh: "ещё глубже — для самых сложных задач",
        max: "максимальная глубина размышлений",
      };
      base = [
        { label: "По умолчанию", detail: "как настроено в CLI claude", value: "" },
        ...levels.map((l) => ({ label: l, detail: hints[l], value: l })),
      ];
      subject = `Claude (${model || "модель по умолчанию"})`;
    } else {
      // Уровни берём из кэша CLI для выбранной модели (у разных моделей
      // разный набор, у gpt-5.6-sol есть ultra); нет в кэше — типовой список.
      const model = this.selectedModel(record, agent) || codexDefaultModel() || "";
      const levels =
        this.codexEffortLevels(model) ??
        ["minimal", "low", "medium", "high", "xhigh"].map((e) => ({
          effort: e,
          description: undefined as string | undefined,
        }));
      base = [
        { label: "По умолчанию", detail: "из ~/.codex/config.toml", value: "" },
        ...levels.map((l) => ({ label: l.effort, detail: l.description, value: l.effort })),
      ];
      subject = `Codex (${model || "модель по умолчанию"})`;
    }

    if (remote) {
      remote.send({
        type: "choices",
        kind: "effort",
        agent,
        title: `Effort для ${subject}`,
        items: base.map((i) => ({ label: i.label, detail: i.detail, value: i.value, current: i.value === current })),
      });
      return;
    }

    const pick = await vscode.window.showQuickPick(
      base.map((i) => ({
        ...i,
        description: i.value === current ? "✓ текущая настройка" : undefined,
      })),
      {
        placeHolder: `Effort для ${subject} — применится со следующего хода`,
        ignoreFocusOut: true,
      },
    );
    if (!pick) return;
    await this.applyEffort(agent, pick.value);
  }

  /** Применить effort агента (глобальная настройка). */
  async applyEffort(agent: AgentId, value: string) {
    const section = vscode.workspace.getConfiguration(`agentHub.${agent}`);
    await section.update("effort", value, vscode.ConfigurationTarget.Global);
    await this.postSettings();
    this.postEfforts();
    this.post({
      type: "info",
      text: value
        ? `Effort ${agent === "claude" ? "Claude" : "Codex"} со следующего хода: ${value}.`
        : `Effort ${agent === "claude" ? "Claude" : "Codex"}: по умолчанию.`,
    });
  }

  /** Поддерживаемые уровни размышлений модели Codex из кэша CLI. */
  private codexEffortLevels(
    model: string,
  ): { effort: string; description?: string }[] | null {
    if (!model) return null;
    try {
      const raw = fs.readFileSync(
        nodePath.join(os.homedir(), ".codex", "models_cache.json"),
        "utf8",
      );
      const parsed = JSON.parse(raw) as {
        models?: {
          slug?: string;
          supported_reasoning_levels?: { effort?: string; description?: string }[];
        }[];
      };
      const entry = (parsed.models ?? []).find((m) => m.slug === model);
      const levels: { effort: string; description?: string }[] = [];
      for (const l of entry?.supported_reasoning_levels ?? []) {
        if (typeof l.effort === "string") {
          levels.push({ effort: l.effort, description: l.description });
        }
      }
      return levels.length > 0 ? levels : null;
    } catch {
      return null;
    }
  }

  /** Модели Codex из кэша CLI (~/.codex/models_cache.json). */
  private listCodexModels(): { slug: string; description?: string }[] {
    try {
      const raw = fs.readFileSync(
        nodePath.join(os.homedir(), ".codex", "models_cache.json"),
        "utf8",
      );
      const parsed = JSON.parse(raw) as {
        models?: { slug?: string; description?: string; visibility?: string }[];
      };
      const out: { slug: string; description?: string }[] = [];
      for (const m of parsed.models ?? []) {
        if (typeof m.slug === "string" && m.visibility !== "hide") {
          out.push({ slug: m.slug, description: m.description });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  // ---------- Slash-команды CLI ----------

  /** Списки slash-команд для меню композера: Claude из кэша CLI, Codex из ~/.codex/prompts. */
  private postSlashCommands() {
    const cached = this.context.globalState.get<SlashCommandInfo[]>(CLAUDE_COMMANDS_KEY);
    this.post({
      type: "slashCommands",
      agent: "claude",
      commands: cached?.length ? cached : DEFAULT_CLAUDE_COMMANDS,
    });
    this.post({ type: "slashCommands", agent: "codex", commands: this.listCodexPrompts() });
  }

  /** Кастомные промпты Codex: файлы *.md в ~/.codex/prompts, имя файла = команда. */
  private listCodexPrompts(): SlashCommandInfo[] {
    const dir = nodePath.join(os.homedir(), ".codex", "prompts");
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: SlashCommandInfo[] = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      let description: string | undefined;
      try {
        const first = fs
          .readFileSync(nodePath.join(dir, f), "utf8")
          .split("\n")
          .find((l) => l.trim());
        if (first) description = first.replace(/^#+\s*/, "").trim().slice(0, 80);
      } catch {
        // без описания
      }
      out.push({ name: f.slice(0, -3), description });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * «/имя аргументы» → содержимое ~/.codex/prompts/имя.md: codex exec сам
   * slash-команды не разворачивает, поэтому подставляем текст промпта здесь.
   */
  private expandCodexPrompt(prompt: string): string | null {
    const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
    if (!m) return null;
    let content: string;
    try {
      content = fs.readFileSync(
        nodePath.join(os.homedir(), ".codex", "prompts", `${m[1]}.md`),
        "utf8",
      );
    } catch {
      return null;
    }
    const args = (m[2] ?? "").trim();
    if (content.includes("$ARGUMENTS")) return content.split("$ARGUMENTS").join(args);
    return args ? `${content.trim()}\n\n${args}` : content;
  }

  /** Клик по плашке файла в ленте: открыть в редакторе этого же окна. */
  private async openFileFromChat(raw: string, projectPath?: string) {
    let p = raw.trim().replace(/^~(?=\/|$)/, os.homedir());
    if (/^[A-Za-z]:[\\/]/.test(p)) {
      void vscode.window.showWarningMessage(`Это путь с другой машины (Windows): ${raw}`);
      return;
    }
    if (!nodePath.isAbsolute(p)) {
      const base = projectPath
        ? this.getProjects().find((project) => projectKey(project) === projectPath)?.path ??
          (!isProjectId(projectPath) ? projectPath : undefined)
        : this.getActiveProject()?.path;
      if (!base) return;
      p = nodePath.join(base, p);
    }
    if (!fs.existsSync(p)) {
      void vscode.window.showWarningMessage(`Файл не найден: ${p}`);
      return;
    }
    const uri = vscode.Uri.file(p);
    if (fs.statSync(p).isDirectory()) {
      await vscode.commands.executeCommand("revealFileInOS", uri);
      return;
    }
    await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
  }

  /** Клик по индикатору режима: default → acceptEdits → YOLO → default (Claude); вкл/выкл YOLO (Codex). */
  private async cycleSafety(agent: AgentId) {
    if (agent === "claude") {
      const section = vscode.workspace.getConfiguration("agentHub.claude");
      const cur = section.get<string>("permissionMode", "default");
      const next =
        cur === "default" ? "acceptEdits" : cur === "acceptEdits" ? "bypassPermissions" : "default";
      if (next === "bypassPermissions") {
        const ok = await vscode.window.showWarningMessage(
          "Включить YOLO для Claude (dangerously-skip-permissions)? Правки, bash и деплой будут выполняться БЕЗ подтверждений.",
          { modal: true },
          "Включить",
        );
        if (ok !== "Включить") return;
      }
      await section.update("permissionMode", next, vscode.ConfigurationTarget.Global);
    } else {
      const section = vscode.workspace.getConfiguration("agentHub.codex");
      const cur = section.get<boolean>("yolo", false);
      if (!cur) {
        const ok = await vscode.window.showWarningMessage(
          "Включить YOLO для Codex? Команды будут выполняться без песочницы и подтверждений (--dangerously-bypass-approvals-and-sandbox).",
          { modal: true },
          "Включить",
        );
        if (ok !== "Включить") return;
      }
      await section.update("yolo", !cur, vscode.ConfigurationTarget.Global);
    }
    this.postSafety();
  }

  /** Список сессий проекта: переключение по клику, удаление корзинкой. */
  /** Переключиться на сессию активного проекта (меню мобильного клиента). */
  async applySession(id: string, chatId?: string, serialized = false): Promise<void> {
    if (!serialized) return this.serializeMultiMutation(() => this.applySession(id, chatId, true));
    const slot = this.findChatSlot(chatId);
    const project = slot
      ? this.getProjects().find((entry) => projectKey(entry) === slot.projectPath)
      : this.getActiveProject();
    if (!project) return;
    if (this.runs.has(chatId ?? projectKey(project))) {
      const event = { type: "error", message: "В этом проекте идёт ход — дождитесь завершения." } as const;
      if (slot) this.postScoped(slot.projectPath, event, chatId);
      else this.post(event);
      return;
    }
    const store = this.getProjectStore(projectKey(project));
    if (!store.sessions.some((s) => s.id === id)) return;
    if (slot) {
      await this.saveChatSlots(this.getChatSlots().map((entry) => entry.chatId === chatId ? { ...entry, recordId: id } : entry));
      await this.postMultiState(chatId);
    } else {
      store.activeId = id;
      this.pruneEmptySessions(store, projectKey(project));
      await this.saveProjectStore(projectKey(project), store);
      this.postFullState();
    }
  }

  async showSessions(remote?: RemoteClient, chatId?: string, serialized = false): Promise<void> {
    if (!serialized) return this.serializeMultiMutation(() => this.showSessions(remote, chatId, true));
    const slot = this.findChatSlot(chatId);
    const project = slot
      ? this.getProjects().find((entry) => projectKey(entry) === slot.projectPath)
      : this.getActiveProject();
    if (!project) return;
    if (this.runs.has(chatId ?? projectKey(project))) {
      const event = { type: "error", message: "В этом проекте идёт ход — дождитесь завершения." } as const;
      if (slot) this.postScoped(slot.projectPath, event, chatId);
      else this.post(event);
      return;
    }
    let store = this.getProjectStore(projectKey(project));
    if (!slot) this.pruneEmptySessions(store, projectKey(project));
    await this.saveProjectStore(projectKey(project), store);
    if (store.sessions.length === 0) {
      const event = { type: "info", text: "История сессий этого проекта пуста." } as const;
      if (slot) this.postScoped(slot.projectPath, event, chatId);
      else this.post(event);
      return;
    }

    if (remote) {
      const fmt = (ts: number) =>
        new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      remote.send({
        type: "choices",
        kind: "session",
        title: `Сессии — ${project.name}`,
        items: [...store.sessions]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((s) => ({
            label: s.title,
            detail: `${fmt(s.updatedAt)} · ${
              [s.agentIds.claude && "Claude", s.agentIds.codex && "Codex"].filter(Boolean).join(" + ") ||
              "без запусков"
            }`,
            value: s.id,
          current: s.id === (slot?.recordId ?? store.activeId),
          })),
      });
      return;
    }

    type Item = vscode.QuickPickItem & { sessionId: string };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `Сессии — ${project.name}`;
    qp.placeholder = "Выберите сессию (корзинка — удалить)";
    qp.ignoreFocusOut = true;

    const format = (ts: number) =>
      new Date(ts).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    const toItems = (): Item[] =>
      [...store.sessions]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((s) => ({
          label: (s.id === (slot?.recordId ?? store.activeId) ? "$(circle-filled) " : "$(comment-discussion) ") + s.title,
          description: format(s.updatedAt),
          detail:
            [s.agentIds.claude && "Claude", s.agentIds.codex && "Codex"]
              .filter(Boolean)
              .join(" + ") || "без запусков",
          sessionId: s.id,
          buttons: [{ iconPath: new vscode.ThemeIcon("trash"), tooltip: "Удалить сессию" }],
        }));
    qp.items = toItems();

    qp.onDidTriggerItemButton(async (e) => {
      const rec = store.sessions.find((s) => s.id === e.item.sessionId);
      if (!rec) return;
      const choice = await vscode.window.showWarningMessage(
        `Удалить сессию «${rec.title}»?`,
        { modal: true },
        "Удалить",
      );
      if (choice !== "Удалить") return;
      await this.serializeMultiMutation(async () => {
        const key = projectKey(project);
        store = this.getProjectStore(key);
        const affected = this.getChatSlots().filter((entry) => entry.projectPath === key && entry.recordId === rec.id);
        if (this.runs.has(key) || affected.some((entry) => this.runs.has(entry.chatId))) {
          const event = { type: "error", message: "Эта сессия используется работающим чатом — сначала остановите его." } as const;
          if (slot) this.postScoped(key, event, chatId);
          else this.post(event);
          return;
        }
        store.sessions = store.sessions.filter((entry) => entry.id !== rec.id);
        if (store.activeId === rec.id) {
          const latest = [...store.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
          store.activeId = latest?.id ?? null;
        }
        const replacements = new Map(affected.map((entry) => {
          const replacement = this.createRecord();
          store.sessions.push(replacement);
          return [entry.chatId, replacement.id];
        }));
        await this.saveProjectStore(key, store);
        if (replacements.size) {
          await this.saveChatSlots(this.getChatSlots().map((entry) => replacements.has(entry.chatId)
            ? { ...entry, recordId: replacements.get(entry.chatId)! } : entry));
        }
        await this.forgetSavedBoardRecord(key, rec.id);
        this.postFullState();
      });
      if (store.sessions.length === 0) {
        qp.hide();
      } else {
        qp.items = toItems();
      }
    });

    qp.onDidAccept(async () => {
      const picked = qp.selectedItems[0];
      if (picked) {
        await this.serializeMultiMutation(async () => {
          store = this.getProjectStore(projectKey(project));
          if (!store.sessions.some((entry) => entry.id === picked.sessionId)) return;
          if (slot) {
            if (this.findChatSlot(chatId)?.projectPath !== slot.projectPath || this.runs.has(chatId!)) return;
            await this.saveChatSlots(this.getChatSlots().map((entry) => entry.chatId === chatId ? { ...entry, recordId: picked.sessionId } : entry));
            await this.postMultiState(chatId);
          } else {
            store.activeId = picked.sessionId;
            this.pruneEmptySessions(store, projectKey(project));
            await this.saveProjectStore(projectKey(project), store);
            this.postFullState();
          }
        });
      }
      qp.hide();
    });

    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  // ---------- Управление сессиями ----------

  async newSession(chatId?: string, serialized = false): Promise<void> {
    if (!serialized) return this.serializeMultiMutation(() => this.newSession(chatId, true));
    const slot = this.findChatSlot(chatId);
    if (slot) {
      if (this.runs.has(chatId!)) {
        this.postScoped(slot.projectPath, { type: "error", message: "Дождитесь окончания хода или остановите его перед созданием новой сессии." }, chatId);
        return;
      }
      const store = this.getProjectStore(slot.projectPath);
      // A fresh identity prevents a delayed save from the old view entering the new session.
      const record = this.createRecord();
      const previous = store.sessions.find((entry) => entry.id === slot.recordId);
      record.modelOverrides = { ...previous?.modelOverrides };
      store.sessions.push(record);
      await this.saveProjectStore(slot.projectPath, store);
      await this.saveChatSlots(this.getChatSlots().map((entry) => entry.chatId === chatId
        ? { ...entry, recordId: record.id } : entry));
      this.pruneEmptySessions(store, slot.projectPath);
      await this.saveProjectStore(slot.projectPath, store);
      await this.postMultiState(chatId);
      this.postScoped(slot.projectPath, { type: "info", text: "Новая сессия." }, chatId);
      return;
    }
    const active = this.getActiveProject();
    if (active) {
      this.runs.get(projectKey(active))?.abort();
      this.denyAllPending(projectKey(active));
    }
    let keptPrevious = false;
    if (active) {
      const store = this.getProjectStore(projectKey(active));
      const current = store.sessions.find((s) => s.id === store.activeId);
      const displayed = this.savedBoardRecordIds(projectKey(active));
      if (current && !hasUserContent(current.items) && !displayed.has(current.id)) {
        // Пустую активную не сохраняем в историю — обнуляем и переиспользуем.
        current.items = [];
        current.agentIds = { claude: null, codex: null };
        current.title = "Новая сессия";
        current.createdAt = Date.now();
        current.updatedAt = Date.now();
        current.context = {};
        current.models = {};
        current.chatLog = [];
        current.chatSeen = {};
        current.modelOverrides = {};
        current.lastPrompts = {};
      } else {
        keptPrevious = !!current;
        const rec = this.createRecord();
        store.sessions.push(rec);
        store.activeId = rec.id;
      }
      this.pruneEmptySessions(store, projectKey(active));
      // Кап истории: держим самые свежие.
      store.sessions = [...store.sessions]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter((record, index) => index < MAX_SESSIONS_PER_PROJECT || displayed.has(record.id) || record.id === store.activeId);
      await this.saveProjectStore(projectKey(active), store);
    }
    this.postFullState();
    if (active) {
      this.postScoped(projectKey(active), {
        type: "info",
        text: keptPrevious
          ? "Новая сессия. Прошлая сохранена в истории (🕘)."
          : "Новая сессия.",
      });
    }
  }

  private post(msg: HostToWebview) {
    this.view?.webview.postMessage(msg);
    this.panel?.webview.postMessage(msg);
    const chatEvents = new Set([
      "projects", "transcript", "busy", "activity", "sessionInfo", "userMessage",
      "textDelta", "assistantText", "toolUse", "turnResult", "info", "error", "reset",
      "permissionRequest", "permissionResolved", "contextUsage", "modelInfo", "draftHandled",
    ]);
    if (!chatEvents.has(msg.type)) this.multiPanel?.webview.postMessage(msg);
    this.remote?.broadcast(msg);
  }

  /** Показать чат пользователю: вкладка приоритетнее сайдбара. */
  private revealUi() {
    if (this.multiPanel) this.multiPanel.reveal(undefined, true);
    else if (this.panel) this.panel.reveal(undefined, true);
    else this.view?.show?.(true);
  }

  /**
   * Переключатель «во всю ширину»: из боковой панели — открыть чат вкладкой
   * редактора и спрятать сайдбар; из вкладки (или повторный вызов командой) —
   * закрыть вкладку и вернуть чат в боковую панель, как было.
   */
  async openFullView(from?: "view" | "panel" | "multi-panel") {
    if (this.panel && from !== "view") {
      this.panel.dispose(); // onDidDispose обнулит this.panel
      await vscode.commands.executeCommand("agentHub.chat.focus");
      return;
    }
    if (this.panel) {
      this.panel.reveal();
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "agentHub.chatPanel",
      "Agent Hub",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg");
    panel.webview.html = this.renderHtml(panel.webview, "panel");
    panel.webview.onDidReceiveMessage((msg: WebviewToHost) =>
      this.onMessage(msg, "vscode", undefined, "panel"),
    );
    panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel = panel;
    // Сайдбар прячем — чат занимает всю ширину окна.
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    this.postFullState();
    await this.postSettings();
  }

  private async onMessage(
    msg: WebviewToHost,
    source: "vscode" | "remote" = "vscode",
    client?: RemoteClient,
    /** Поверхность VS Code, приславшая сообщение: боковая панель или вкладка. */
      surface?: "view" | "panel" | "multi-panel",
    serialized = false,
  ): Promise<void> {
    if (!serialized && (
      ["selectProject", "moveProject", "reorderProjects", "openMultiChat", "createChat", "removeChat", "selectChatProject", "selectChatSession", "selectChatAgent", "newSession", "saveTranscript"].includes(msg.type) ||
      (surface === "multi-panel" && (msg.type === "ready" || msg.type === "multiStateReady"))
    )) {
      return this.serializeMultiMutation(() => this.onMessage(msg, source, client, surface, true));
    }
    // Мобильный клиент: действия с нативными диалогами VS Code недоступны,
    // а пикеры модели/effort/сессий заменяются меню в самом webview.
    if (source === "remote") {
      if (VSCODE_ONLY_ACTIONS.has(msg.type)) {
        client?.send({ type: "info", text: "Это действие доступно только в VS Code на компьютере." });
        return;
      }
      if (msg.type === "pickModel") {
        await this.pickModel(msg.agent, client);
        return;
      }
      if (msg.type === "pickEffort") {
        await this.pickEffort(msg.agent, client);
        return;
      }
      if (msg.type === "showSessions") {
        await this.showSessions(client);
        return;
      }
    }
    switch (msg.type) {
      case "ready":
        if (surface === "multi-panel" && msg.chatId) await this.postMultiState(msg.chatId);
        else if (surface === "multi-panel") await this.ensureMultiChats();
        else this.postFullState();
        break;
      case "multiStateReady":
        if (surface === "multi-panel") await this.ensureMultiChats();
        break;
      case "createChat":
        if (surface === "multi-panel") await this.createMultiChat(msg.projectPath);
        break;
      case "removeChat":
        if (surface === "multi-panel") await this.removeMultiChat(msg.chatId);
        break;
      case "selectChatProject":
        if (surface === "multi-panel") await this.selectMultiChatProject(msg.chatId, msg.projectPath);
        break;
      case "selectChatSession":
        if (surface === "multi-panel") await this.selectMultiChatSession(msg.chatId, msg.recordId);
        break;
      case "selectChatAgent":
        if (surface === "multi-panel") await this.selectMultiChatAgent(msg.chatId, msg.agent);
        break;
      case "stop": {
        const slot = this.findChatSlot(msg.chatId);
        const requested = msg.path ?? this.getActiveProjectKey();
        const target = msg.chatId ?? requested;
        // Ищем, что останавливать: запрошенный проект → единственный запуск.
        const runTarget =
          target && this.runs.has(target)
            ? target
            : !target && this.runs.size === 1
              ? [...this.runs.keys()][0]
              : undefined;
        if (runTarget) {
          this.postScoped(slot?.projectPath ?? requested ?? "", { type: "activity", label: "Останавливаю…" }, msg.chatId);
          this.runs.get(runTarget)?.abort();
          this.denyAllPending(slot?.projectPath ?? requested, msg.chatId);
          // Страховка: бэкенд не завершился за 6 с — принудительно чистим UI.
          setTimeout(() => {
            if (this.runs.has(runTarget)) {
              this.runs.delete(runTarget);
              this.postScoped(slot?.projectPath ?? requested ?? "", { type: "busy", value: false }, msg.chatId);
              this.postScoped(slot?.projectPath ?? requested ?? "", {
                type: "error",
                message: "Ход остановлен принудительно: бэкенд не ответил на прерывание.",
              }, msg.chatId);
            }
          }, 6000);
        } else if (requested) {
          // Запусков нет, а UI считает проект занятым (рассинхрон после
          // перезагрузки) — «Стоп» приводит панель в порядок.
          this.denyAllPending(requested, msg.chatId);
          this.postScoped(slot?.projectPath ?? requested, { type: "busy", value: false }, msg.chatId);
        }
        break;
      }
      case "newSession":
        await this.newSession(msg.chatId, true);
        break;
      case "send":
        await this.runTurn(msg.text, msg.agent, msg.attachments ?? [], msg.path, true, undefined, msg.chatId);
        break;
      case "steer": {
        const slot = this.findChatSlot(msg.chatId);
        const target = slot?.projectPath ?? msg.path ?? this.getActiveProjectKey();
        const runKey = msg.chatId ?? target ?? "";
        const channel = target ? this.steers.get(runKey) : undefined;
        if (!target || !this.runs.has(runKey) || !channel?.handler) {
          // Ход уже закончился или агент не принимает сообщения на лету — обычная отправка.
          await this.runTurn(msg.text, msg.agent, msg.attachments ?? [], target, true, undefined, msg.chatId);
          break;
        }
        const project = this.getProjects().find((p) => projectKey(p) === target);
        if (!project) break;
        const files = await this.relocateAttachments(project.path, msg.attachments ?? [], target);
        const text = files.length > 0 ? `${buildAttachmentsBlock(files)}\n\n${msg.text}` : msg.text;
        this.postScoped(target, {
          type: "userMessage",
          text: msg.text,
          attachments: files.length > 0 ? files.map((a) => a.name) : undefined,
        }, msg.chatId);
        try {
          await channel.handler(text, msg.mode);
          const list = this.steerTexts.get(runKey) ?? [];
          list.push(text);
          this.steerTexts.set(runKey, list);
          this.postScoped(target, {
            type: "info",
            text:
              msg.mode === "now"
                ? "⚡ Сообщение отправлено агенту немедленно — текущий шаг прерывается."
                : "↪ Сообщение докинуто в идущий ход — агент учтёт его на ближайшем шаге.",
          }, msg.chatId);
        } catch (err) {
          this.postScoped(target, {
            type: "info",
            text: `Докинуть в идущий ход не удалось (${err instanceof Error ? err.message : err}) — сообщение уйдёт после завершения хода.`,
          }, msg.chatId);
          this.deferTurn(target, msg.agent, msg.text, undefined, msg.chatId);
        }
        break;
      }
      case "pickAttachment": {
        const slot = this.findChatSlot(msg.chatId);
        const target = slot?.projectPath ?? msg.path ?? this.getActiveProjectKey();
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          openLabel: "Прикрепить",
        });
        if (picked?.length) {
          const event: HostToWebview = {
            type: "attachmentAdded",
            files: picked.map((u) => ({ name: nodePath.basename(u.fsPath), path: u.fsPath })),
          };
          if (target) this.postScoped(target, event, msg.chatId);
        }
        break;
      }
      case "saveAttachment":
        await this.saveAttachment(msg.name, msg.dataBase64, msg.path, msg.chatId);
        break;
      case "finishSession":
        await this.finishSession(msg.agent, msg.chatId);
        break;
      case "selectProject":
        await this.setActivePath(msg.path);
        this.postFullState();
        break;
      case "addProject":
        await this.addProject();
        break;
      case "deleteProject":
        await this.deleteProject(msg.path);
        break;
      case "archiveProject":
        await this.archiveProject(msg.path);
        break;
      case "restoreProject":
        await this.restoreProject(msg.path);
        break;
      case "showArchive":
        await this.showArchive();
        break;
      case "moveProject":
        await this.moveProject(msg.path, msg.direction);
        break;
      case "reorderProjects":
        await this.reorderProjects(msg.paths);
        break;
      case "manageProjects":
        await this.manageProjects(msg.chatId);
        break;
      case "saveTranscript": {
        const store = this.getProjectStore(msg.path);
        const slot = this.findChatSlot(msg.chatId);
        const rec = msg.chatId
          ? (slot?.projectPath === msg.path && slot.recordId === msg.recordId
            ? store.sessions.find((s) => s.id === slot.recordId) : undefined)
          : store.sessions.find((s) => s.id === store.activeId);
        if (rec) {
          const previousTitle = rec.title;
          rec.items = msg.items.slice(-TRANSCRIPT_MAX_ITEMS);
          rec.updatedAt = Date.now();
          if (rec.title === "Новая сессия") {
            rec.title = deriveTitle(rec.items) ?? rec.title;
          }
          await this.saveProjectStore(msg.path, store);
          if (msg.chatId && rec.title !== previousTitle) this.postMultiBoardState();
        }
        break;
      }
      case "showSessions":
        await this.showSessions(undefined, msg.chatId);
        break;
      case "openMultiChat":
        await this.openMultiChat();
        break;
      case "duplicateProject":
        await this.duplicateProject(msg.path, msg.copyFolder);
        break;
      case "openFullView":
        await this.openFullView(surface);
        break;
      case "getSettings":
        await this.postSettings(msg.chatId);
        break;
      case "exportSettings":
        await this.exportSettings();
        break;
      case "testServer":
        await this.testServer(msg);
        break;
      case "importSettings":
        await this.importSettings();
        break;
      case "applyConfigJson":
        await this.applyConfigJson(msg.json);
        break;
      case "saveSettings":
        await this.applySettings(msg.settings, msg.chatId);
        break;
      case "cycleSafety":
        await this.cycleSafety(msg.agent);
        break;
      case "pickModel":
        await this.pickModel(msg.agent, undefined, msg.chatId);
        break;
      case "pickEffort":
        await this.pickEffort(msg.agent, undefined, msg.chatId);
        break;
      case "showContext":
        await this.showContext(msg.agent, msg.chatId);
        break;
      case "manageSecretEnv":
        await this.manageSecretEnv(msg.chatId);
        break;
      case "sendSecretEnv":
        await this.sendSecretEnvFromMessage(msg.text, msg.path, msg.chatId);
        break;
      case "openFile":
        await this.openFileFromChat(msg.path, msg.project);
        break;
      case "choose":
        if (msg.kind === "model") {
          await this.applyModel(msg.agent ?? "claude", msg.value, msg.scope === "base", msg.chatId);
        } else if (msg.kind === "effort") {
          await this.applyEffort(msg.agent ?? "claude", msg.value);
        } else {
          await this.applySession(msg.value, msg.chatId);
        }
        break;
      case "permission": {
        const pending = this.pendingPermissions.get(msg.requestId);
        if (pending && (!pending.chatId || pending.chatId === msg.chatId)) {
          this.pendingPermissions.delete(msg.requestId);
          await pending.resolve({ allow: msg.allow, answer: msg.answer });
        }
        break;
      }
      default: {
        // Компилятор упадёт, если в WebviewToHost появится необработанный тип.
        const unhandled: never = msg;
        void unhandled;
      }
    }
  }

  /** Сохранить вставленный/перетащенный файл в <проект>/.agent-hub/attachments/. */
  private async saveAttachment(name: string, dataBase64: string, projectPath?: string, chatId?: string) {
    // Проект — тот, чья лента прислала файл: «активный» хоста мог отличаться
    // (переключение, другое окно), и вложение уезжало в чужую папку.
    const slot = this.findChatSlot(chatId);
    if (chatId && !slot) return;
    if (slot && projectPath && projectPath !== slot.projectPath) return;
    projectPath = slot?.projectPath ?? projectPath;
    const project = projectPath
      ? this.getProjects().find((p) => projectKey(p) === projectPath)
      : this.getActiveProject();
    if (!project) {
      this.post({ type: "error", message: "Нет активного проекта — некуда сохранить вложение." });
      return;
    }
    try {
      const dir = nodePath.join(project.path, ".agent-hub", "attachments");
      await fs.promises.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const safeName = name.replace(/[^\wа-яА-ЯёЁ.\-]+/g, "_") || "file";
      const filePath = nodePath.join(dir, `${stamp}-${randomUUID()}-${safeName}`);
      await fs.promises.writeFile(filePath, Buffer.from(dataBase64, "base64"));
      this.postScoped(projectKey(project), {
        type: "attachmentAdded",
        files: [{ name: nodePath.basename(filePath), path: filePath }],
      }, chatId);
    } catch (err) {
      const event: HostToWebview = {
        type: "error",
        message: `Не удалось сохранить вложение: ${err instanceof Error ? err.message : err}`,
      };
      if (project) this.postScoped(projectKey(project), event, chatId);
      else this.post(event);
    }
  }

  /** Отклонить зависшие подтверждения: по проекту или все (path не задан). */
  private denyAllPending(path?: string, chatId?: string) {
    for (const [requestId, pending] of [...this.pendingPermissions]) {
      if (path && pending.path !== path) continue;
      if (chatId && pending.chatId !== chatId) continue;
      pending.resolve({ allow: false });
      this.pendingPermissions.delete(requestId);
      this.postScoped(pending.path, { type: "permissionResolved", requestId, allow: false }, pending.chatId);
    }
  }

  /** Вложения из .agent-hub/attachments другого проекта — скопировать в текущий. */
  private async relocateAttachments(cwd: string, attachments: Attachment[], eventKey = cwd): Promise<Attachment[]> {
    if (attachments.length === 0) return attachments;
    const marker = `${nodePath.sep}.agent-hub${nodePath.sep}attachments${nodePath.sep}`;
    const others = this.getProjects()
      .map((p) => p.path)
      .filter((p) => physicalDirectory(p) !== physicalDirectory(cwd));
    const out: Attachment[] = [];
    for (const a of attachments) {
      const foreign =
        a.path.includes(marker) &&
        !a.path.startsWith(cwd + nodePath.sep) &&
        others.some((p) => a.path.startsWith(p + nodePath.sep));
      if (!foreign) {
        out.push(a);
        continue;
      }
      try {
        const dir = nodePath.join(cwd, ".agent-hub", "attachments");
        await fs.promises.mkdir(dir, { recursive: true });
        const dest = nodePath.join(dir, `${randomUUID()}-${nodePath.basename(a.path)}`);
        await fs.promises.copyFile(a.path, dest);
        out.push({ name: a.name, path: dest });
        this.postScoped(eventKey, {
          type: "info",
          text: `Вложение «${a.name}» лежало в папке другого проекта — скопировано в этот проект.`,
        });
      } catch {
        out.push(a);
      }
    }
    return out;
  }

  private isQuestionOriginCurrent(cwd: string, agent: AgentId, origin: QuestionOrigin): boolean {
    if (!this.getProjects().some((project) => projectKey(project) === cwd)) return false;
    const slot = this.findChatSlot(origin.chatId);
    const current = slot
      ? slot.projectPath === cwd
        ? this.getProjectStore(cwd).sessions.find((record) => record.id === slot.recordId) ?? null
        : null
      : this.getActiveRecord(cwd);
    return !!current && current.id === origin.recordId && current.createdAt === origin.createdAt &&
      current.agentIds[agent] === origin.sessionId;
  }

  private reportExpiredQuestion(cwd: string, chatId?: string) {
    this.postScoped(cwd, {
      type: "info",
      text: "Ответ относится к прежней сессии или удалённому проекту и устарел. Он не отправлен; задайте сообщение в нужной сессии заново.",
    }, chatId);
  }

  /** Ход после завершения текущего (или сразу, если проект свободен). */
  private deferTurn(cwd: string, agent: AgentId, prompt: string, questionOrigin?: QuestionOrigin, chatId?: string) {
    if (questionOrigin && !this.isQuestionOriginCurrent(cwd, agent, questionOrigin)) {
      this.reportExpiredQuestion(cwd, chatId);
      return false;
    }
    const runKey = chatId ?? cwd;
    if (this.runs.has(runKey)) {
      const list = this.deferred.get(runKey) ?? [];
      list.push({ prompt, agent, chatId, questionOrigin });
      this.deferred.set(runKey, list);
      return true;
    }
    void this.runTurn(prompt, agent, [], cwd, true, questionOrigin, chatId);
    return true;
  }

  // ---------- Мобильный доступ (удалённый клиент) ----------

  private async remoteToken(): Promise<string> {
    let t = await this.context.secrets.get(REMOTE_TOKEN_KEY);
    if (!t) {
      t = generateToken();
      await this.context.secrets.store(REMOTE_TOKEN_KEY, t);
    }
    return t;
  }

  /** Поднять/остановить сервер по настройке agentHub.remote.enabled. */
  private async syncRemoteServer() {
    const cfg = vscode.workspace.getConfiguration("agentHub.remote");
    const enabled = this.remoteForced || cfg.get<boolean>("enabled", false);
    const port = cfg.get<number>("port", 47831);
    if (!enabled) {
      this.remote?.stop();
      this.remote = null;
      return;
    }
    if (this.remote?.running && this.remote.port === port) return;
    this.remote?.stop();
    this.remote = null;
    const token = await this.remoteToken();
    const server = new RemoteServer({
      port,
      token,
      distDir: vscode.Uri.joinPath(this.context.extensionUri, "dist").fsPath,
      mediaDir: vscode.Uri.joinPath(this.context.extensionUri, "media").fsPath,
      onMessage: (client, msg) => void this.onMessage(msg as WebviewToHost, "remote", client),
    });
    try {
      await server.start();
      this.remote = server;
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Agent Hub: не удалось запустить мобильный доступ на порту ${port}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Команда «Мобильный доступ»: включить сервер и показать ссылки + QR. */
  async showRemoteAccess() {
    const cfg = vscode.workspace.getConfiguration("agentHub.remote");
    if (!cfg.get<boolean>("enabled", false)) {
      try {
        await cfg.update("enabled", true, vscode.ConfigurationTarget.Global);
      } catch {
        // Окно не перезагружено после обновления расширения: команда уже есть,
        // а схема настроек ещё старая — включаем до перезапуска и просим Reload.
        this.remoteForced = true;
        void vscode.window.showWarningMessage(
          "Agent Hub: настройка не сохранилась — окно VS Code не перезагружено после обновления. " +
            "Мобильный доступ включён до перезапуска; выполните «Developer: Reload Window», чтобы он включался сам.",
        );
      }
    }
    await this.syncRemoteServer();
    if (!this.remote) return;
    const port = this.remote.port;
    const token = await this.remoteToken();
    const ts = await tailscaleInfo(port);

    const links: { title: string; url: string; note: string }[] = [];
    if (ts?.funnel && ts.dnsName) {
      links.push({
        title: "Интернет — из любой сети (Tailscale Funnel)",
        url: `https://${ts.dnsName}/t/${token}/`,
        note: "Телефону не нужен ни VPN, ни общая Wi-Fi. Адрес публичный — защищён только токеном, не публикуйте ссылку.",
      });
    }
    if (ts?.serveHttps && ts.dnsName) {
      links.push({
        title: "Tailscale HTTPS (рекомендуется)",
        url: `https://${ts.dnsName}/t/${token}/`,
        note: "Через Tailscale Serve: в Chrome доступно «Установить приложение»",
      });
    }
    if (ts?.ip) {
      links.push({
        title: "Tailscale",
        url: `http://${ts.ip}:${port}/t/${token}/`,
        note: "Телефон должен быть в той же tailnet (приложение Tailscale)",
      });
    }
    for (const a of lanAddresses()) {
      links.push({
        title: `Wi-Fi / локальная сеть (${a.name})`,
        url: `http://${a.address}:${port}/t/${token}/`,
        note: "Только когда телефон в той же сети",
      });
    }
    if (links.length === 0) {
      links.push({ title: "Локально", url: `http://127.0.0.1:${port}/t/${token}/`, note: "Сетевые интерфейсы не найдены" });
    }
    const cards = await Promise.all(
      links.map(async (l) => {
        // Схема для Android-приложения: agenthub:// → http, agenthubs:// → https.
        const app = l.url.startsWith("https://")
          ? l.url.replace(/^https:\/\//, "agenthubs://")
          : l.url.replace(/^http:\/\//, "agenthub://");
        const [svg, appSvg] = await Promise.all([
          QRCode.toString(l.url, { type: "svg", margin: 1, width: 220 }),
          QRCode.toString(app, { type: "svg", margin: 1, width: 220 }),
        ]);
        return (
          `<section><h2>${escapeHtml(l.title)}</h2><p class="note">${escapeHtml(l.note)}</p>` +
          `<div class="row"><div><div class="cap">Браузер / PWA</div>${svg}<code>${escapeHtml(l.url)}</code></div>` +
          `<div><div class="cap">Приложение Android</div>${appSvg}<code>${escapeHtml(app)}</code></div></div></section>`
        );
      }),
    );
    const panel = vscode.window.createWebviewPanel(
      "agentHub.remoteAccess",
      "Agent Hub: мобильный доступ",
      vscode.ViewColumn.Beside,
      {},
    );
    panel.webview.html =
      `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><style>` +
      `body{font-family:var(--vscode-font-family);padding:12px 18px;color:var(--vscode-foreground)}h1{font-size:18px}` +
      `h2{font-size:15px;margin:18px 0 4px}.note{opacity:.7;margin:0 0 8px}.row{display:flex;gap:24px;flex-wrap:wrap}` +
      `.cap{font-size:12px;opacity:.7;margin-bottom:4px}svg{width:220px;height:220px;background:#fff;padding:6px;border-radius:6px}` +
      `code{display:block;max-width:260px;word-break:break-all;font-size:11px;margin-top:6px;opacity:.85}` +
      `.warn{border-left:3px solid #cca700;padding:6px 10px;margin:10px 0}</style></head><body>` +
      `<h1>📱 Мобильный доступ</h1>` +
      `<div class="warn">Ссылка содержит секретный токен — по ней агенты выполняют команды на этом компьютере. Не публикуйте её. VS Code должен быть открыт.</div>` +
      `<p>Порт ${port}${ts?.state === "Running" ? " · Tailscale " + escapeHtml(ts.ip ?? "") : " · Tailscale выключен"}` +
      `${ts?.funnel ? " · доступ из интернета включён" : ""}` +
      `${this.remote.clientCount ? ` · подключено клиентов: ${this.remote.clientCount}` : ""}</p>` +
      cards.join("") +
      `<p class="note">Android-приложение Agent Hub: отсканируйте QR «Приложение Android» камерой — ссылка agenthub:// откроет его. В Chrome ссылку можно добавить на главный экран.</p>` +
      `</body></html>`;

    const buttons = [
      ...(!ts?.funnel ? ["Доступ из любой сети"] : []),
      "Сбросить токен",
      "Выключить",
    ];
    const choice = await vscode.window.showInformationMessage(
      "Agent Hub: мобильный доступ включён — ссылки и QR открыты рядом.",
      ...buttons,
    );
    if (choice === "Доступ из любой сети") {
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Agent Hub: включаю Tailscale Funnel…" },
        () => enableTailscaleFunnel(port),
      );
      if (r.url) {
        // Нужен шаг в браузере: вход в Tailscale или разрешение Funnel для сети.
        void vscode.env.openExternal(vscode.Uri.parse(r.url));
        void vscode.window.showInformationMessage(
          `${r.message} Открыл страницу Tailscale в браузере — подтвердите там и запустите «Мобильный доступ» ещё раз.`,
        );
      } else if (r.ok) {
        panel.dispose();
        void vscode.window.showInformationMessage(
          "Доступ из любой сети включён — ссылка «Интернет» в обновлённой панели.",
        );
        void this.showRemoteAccess();
      } else {
        void vscode.window.showErrorMessage(`Tailscale Funnel: ${r.message || "не удалось включить"}`);
      }
    } else if (choice === "Сбросить токен") {
      await this.context.secrets.delete(REMOTE_TOKEN_KEY);
      this.remote.stop();
      this.remote = null;
      await this.syncRemoteServer();
      void vscode.window.showInformationMessage(
        "Токен сброшен — старые ссылки больше не работают. Откройте команду ещё раз.",
      );
    } else if (choice === "Выключить") {
      this.remoteForced = false;
      try {
        await cfg.update("enabled", false, vscode.ConfigurationTarget.Global);
      } catch {
        // окно не перезагружено — просто останавливаем сервер
      }
      this.remote?.stop();
      this.remote = null;
    }
  }

  /** При выгрузке расширения: оборвать все ходы и добить процессы агентов. */
  abortAll() {
    for (const c of this.runs.values()) c.abort();
    killAllCodex();
    this.remote?.stop();
    this.remote = null;
  }

  private async runTurn(
    prompt: string,
    agent: AgentId,
    attachments: Attachment[] = [],
    targetPath?: string,
    echoUser = false,
    expectedQuestionOrigin?: QuestionOrigin,
    chatId?: string,
    admitted = false,
  ): Promise<void> {
    if (!admitted) {
      let turn: Promise<void> | undefined;
      // Serialize only binding capture and run registration, never the running agent.
      await this.serializeMultiMutation(async () => {
        turn = this.runTurn(prompt, agent, attachments, targetPath, echoUser, expectedQuestionOrigin, chatId, true);
      });
      await turn;
      return;
    }
    if (this.context.globalState.get<PendingProjectMove | undefined>(PROJECT_MOVE_KEY)) {
      const message: HostToWebview = { type: "error", message: "Не завершено перемещение папки проекта. Перезапустите окно VS Code для восстановления состояния перед запуском агента." };
      const target = this.findChatSlot(chatId)?.projectPath ?? targetPath;
      if (target) this.postScoped(target, message, chatId);
      else if (chatId) this.multiPanel?.webview.postMessage({ ...message, chatId });
      else this.post(message);
      return;
    }
    const slot = this.findChatSlot(chatId);
    if (chatId && (!slot || (targetPath && targetPath !== slot.projectPath))) {
      this.multiPanel?.webview.postMessage({ type: "error", message: "Чат уже удалён или его проект изменился. Обновите мультичат.", chatId });
      return;
    }
    const project = slot
      ? (this.getProjects().find((p) => projectKey(p) === slot.projectPath) ?? null)
      : targetPath
      ? (this.getProjects().find((p) => projectKey(p) === targetPath) ?? null)
      : this.getActiveProject();
    if (!project) {
      this.post({
        type: "error",
        message: targetPath
          ? "Проект отложенного сообщения удалён из списка — сообщение не отправлено."
          : "Нет проектов. Добавьте проект через «＋ Добавить проект…» или откройте папку.",
      });
      return;
    }
    const cwd = projectKey(project);
    const runKey = chatId ?? cwd;
    const workingDir = project.path;
    const emit = (msg: HostToWebview) => this.postScoped(cwd, msg, chatId);
    if (expectedQuestionOrigin && !this.isQuestionOriginCurrent(cwd, agent, expectedQuestionOrigin)) {
      this.reportExpiredQuestion(cwd, chatId);
      return;
    }
    if (this.runs.has(runKey)) {
      emit({
        type: "error",
        message: `В этом чате уже идёт ход. Дождитесь ответа или остановите его.`,
      });
      return;
    }
    if (!fs.existsSync(workingDir)) {
      emit({ type: "error", message: `Папка проекта не найдена: ${workingDir}` });
      return;
    }

    const directory = physicalDirectory(workingDir);
    const directoryRuns = (this.directoryRuns ??= new Map());
    const group = directoryRuns.get(directory) ?? { controllers: new Set<AbortController>(), overlapped: false };
    if (group.controllers.size > 0) group.overlapped = true;
    const controller = new AbortController();
    group.controllers.add(controller);
    directoryRuns.set(directory, group);
    this.runs.set(runKey, controller);
    const releaseDirectory = () => {
      const current = directoryRuns.get(directory);
      current?.controllers.delete(controller);
      if (current?.controllers.size === 0 && current === group) directoryRuns.delete(directory);
    };
    let releaseWriter: () => void = () => {};
    try {

    // Изоляция проектов: вложение из папки ДРУГОГО проекта (старый дефект —
    // сохранялось в «активный» проект хоста) копируем сюда, чтобы агент не
    // ходил в чужую папку и не узнавал о другом проекте.
    attachments = await this.relocateAttachments(workingDir, attachments, cwd);
    if (controller.signal.aborted || this.runs.get(runKey) !== controller ||
        !directoryRuns.get(directory)?.controllers.has(controller) ||
        (expectedQuestionOrigin && !this.isQuestionOriginCurrent(cwd, agent, expectedQuestionOrigin))) {
      if (expectedQuestionOrigin) this.reportExpiredQuestion(cwd, chatId);
      return;
    }

    const discardStaleQuestion = () => {
      if (!expectedQuestionOrigin || (!controller.signal.aborted &&
        this.runs.get(runKey) === controller &&
        this.isQuestionOriginCurrent(cwd, agent, expectedQuestionOrigin))) return false;
      if (this.runs.get(runKey) === controller) {
        this.runs.delete(runKey);
        emit({ type: "busy", value: false });
      }
      this.reportExpiredQuestion(cwd, chatId);
      return true;
    };
    if (echoUser && !expectedQuestionOrigin) {
      // Пузырь пользователя рассылает хост — обе поверхности видят одно и то же.
      emit({
        type: "userMessage",
        text: prompt,
        attachments: attachments.length ? attachments.map((a) => a.name) : undefined,
      });
    }
    emit({ type: "busy", value: true });
    emit({ type: "activity", label: "Запускается…" });

    // Перед изменениями — актуальная версия: подтягиваем новые коммиты,
    // чтобы агент (и журнал сессий) работали поверх свежего кода.
    if (group.gitOperation) await group.gitOperation;
    if (group.overlapped) {
      emit({ type: "info", text: "В этой папке уже работает другой чат: автообновление Git пропущено." });
    } else {
      const operation = this.autoPull(workingDir, cwd, chatId);
      group.gitOperation = operation;
      await operation;
      if (group.gitOperation === operation) group.gitOperation = undefined;
    }
    if (discardStaleQuestion()) return;

    // Slash-команды: Claude Code исполняет их сам, но промпт обязан НАЧИНАТЬСЯ
    // с «/» — никаких префиксов. Codex exec команды не понимает — кастомный
    // промпт из ~/.codex/prompts разворачиваем в текст здесь.
    let userText = prompt;
    if (agent === "codex" && prompt.trimStart().startsWith("/")) {
      const expanded = this.expandCodexPrompt(prompt);
      if (expanded !== null) {
        userText = expanded;
        emit({
          type: "info",
          text: `Команда развёрнута из ~/.codex/prompts.`,
        });
      }
    }
    const isSlashCommand = agent === "claude" && userText.trimStart().startsWith("/");

    // Вложения идут вместе с текстом сообщения — блок путей перед задачей
    // (после команды, если это slash-команда).
    const attachBlock = attachments.length > 0 ? buildAttachmentsBlock(attachments) : "";
    const promptWithAttachments = attachBlock
      ? isSlashCommand
        ? `${userText}\n\n${attachBlock}`
        : `${attachBlock}\n\n${userText}`
      : userText;

    // Новая сессия — карточка проекта + контекст из журнала (общая память).
    const store = this.getProjectStore(cwd);
    let record = slot ? store.sessions.find((item) => item.id === slot.recordId) : null;
    if (!record && slot) {
      emit({ type: "error", message: "Сессия чата удалена из истории." });
      return;
    }
    record ??= await this.ensureActiveRecord(cwd);
    const writerKeys = [`record:${cwd}:${record.id}:${agent}`];
    if (record.agentIds[agent]) writerKeys.push(`session:${agent}:${record.agentIds[agent]}`);
    const conflictingWriter = writerKeys.find((key) => this.sessionWriters.has(key));
    if (conflictingWriter) {
      emit({ type: "error", message: "Эта CLI-сессия уже запущена в другом чате. Выберите отдельную сессию." });
      return;
    }
    for (const key of writerKeys) this.sessionWriters.set(key, controller);
    releaseWriter = () => {
      for (const key of writerKeys) if (this.sessionWriters.get(key) === controller) this.sessionWriters.delete(key);
    };
    if (discardStaleQuestion()) return;
    const sessions = record.agentIds;

    // Контекст между агентами: лента чата общая, а CLI-сессии раздельные.
    // Сообщения, обработанные другим агентом, этот агент не видел — подкладываем
    // их в промпт. Slash-команды пропускаем: их промпт обязан начинаться с «/».
    const chatLog = record.chatLog ?? [];
    const seenIdx = Math.min(record.chatSeen?.[agent] ?? 0, chatLog.length);
    const unseen = chatLog.slice(seenIdx).filter((e) => e.agent !== agent);
    const crossContext = isSlashCommand ? null : buildCrossContext(unseen);
    if (crossContext) {
      emit({
        type: "info",
        text: `В контекст добавлены сообщения другого агента из этой ленты: ${crossContext.count}.`,
      });
    }

    // Один снимок секретов для карточки и процесса, включая resumed-сессии.
    const serverEnv = buildServerEnvironment(
      await this.getSecretEnv(projectKey(project)),
      await this.context.secrets.get(this.passwordKey(projectKey(project))),
    );
    if (discardStaleQuestion()) return;
    const projectCard = isSlashCommand ? "" : await this.buildProjectCard(project, serverEnv);
    if (discardStaleQuestion()) return;
    let fullPrompt = promptWithAttachments;
    if (!sessions[agent] && !isSlashCommand) {
      const cfg = vscode.workspace.getConfiguration("agentHub");
      const parts: string[] = [projectCard];
      const journalContext = await readJournalContext(
        workingDir,
        cfg.get<string>("journalDir", "docs/journal"),
        cfg.get<number>("journalContextEntries", 3),
      );
      if (discardStaleQuestion()) return;
      if (journalContext) {
        parts.push(journalContext);
        emit({ type: "info", text: "В контекст добавлены записи журнала сессий." });
      }
      if (crossContext) parts.push(crossContext.block);
      parts.push(`Задача пользователя:\n${promptWithAttachments}`);
      fullPrompt = parts.join("\n\n");
    } else if (crossContext) {
      fullPrompt = `${crossContext.block}\n\nНовое сообщение пользователя:\n${promptWithAttachments}`;
    }

    if (sessions[agent] && !isSlashCommand) {
      fullPrompt = `Актуальные настройки проекта для этого хода (заменяют прежние):\n${projectCard}\n\n${fullPrompt}`;
    }

    // Копим ответ агента для общего лога беседы (Claude — дельтами,
    // Codex и slash-вывод — целыми сообщениями).
    let answerBuf = "";
    let delivered = false;
    let turnSucceeded = false;
    let nextDeferred: DeferredTurn | undefined;
    let currentSessionId = sessions[agent];
    const questionAnswers: string[] = [];
    let turnLogDone: Promise<void> | null = null;

    // Мутации привязаны к записи хода: пока ход шёл, «Новая сессия» могла
    // переключить активную запись или переиспользовать эту же (тот же id,
    // но новый createdAt) — данные хода в чужую/очищенную запись не пишем.
    const recordGen = record.createdAt;
    let questionPreparation = !!expectedQuestionOrigin;
    const mutateTurnRecord = (fn: (rec: SessionRecord) => void) =>
      this.mutateRecord(cwd, record.id, (r) => {
        if (r.createdAt !== recordGen) return;
        if (questionPreparation && expectedQuestionOrigin && (controller.signal.aborted ||
          this.runs.get(runKey) !== controller ||
          !this.isQuestionOriginCurrent(cwd, agent, expectedQuestionOrigin))) return;
        fn(r);
      });

    // Точный промпт хода — для просмотрщика контекста («🧠 что видит агент»).
    if (discardStaleQuestion()) return;
    await mutateTurnRecord((r) => {
      r.lastPrompts = {
        ...r.lastPrompts,
        [agent]:
          fullPrompt.length > 80_000
            ? fullPrompt.slice(0, 80_000) + "\n…[обрезано]"
            : fullPrompt,
      };
    });

    if (discardStaleQuestion()) return;
    try {
      if (echoUser && expectedQuestionOrigin) {
        emit({
          type: "userMessage", text: prompt,
          attachments: attachments.length ? attachments.map((a) => a.name) : undefined,
        });
      }
      questionPreparation = false;
      const backend =
        agent === "codex" &&
        vscode.workspace.getConfiguration("agentHub.codex").get<string>("transport", "appServer") ===
          "exec"
          ? this.codexExec
          : this.backends[agent];
      const steer: SteerChannel = {};
      this.steers.set(runKey, steer);
      const events = backend.start(fullPrompt, {
        cwd: workingDir,
        resumeSessionId: sessions[agent] ?? undefined,
        signal: controller.signal,
        steer,
        refreshModels: agent === "claude" && this.claudeModelsStale(),
        cliPath: agent === "claude" ? this.resolveClaudeCli() : undefined,
        extraEnv: serverEnv,
        config: this.buildAgentConfig(agent, record.modelOverrides?.[agent]),
        attachments: attachments.map((a) => ({ path: a.path, isImage: isImagePath(a.path) })),
        confirmTool: (toolName, input) => this.confirmTool(toolName, input, cwd, chatId, record.id),
      });

      // «Доставлено» — только содержательные события (сессия создана, текст,
      // инструменты, успешный результат). Ошибки Codex приходят событиями, а не
      // исключениями: сбой CLI до старта треда не должен помечать контекст
      // «увиденным» — иначе другой агент потеряет эти сообщения навсегда.
      for await (const ev of events) {
        switch (ev.kind) {
          case "session":
            currentSessionId = ev.sessionId;
            delivered = true;
            await mutateTurnRecord((r) => {
              r.agentIds[agent] = ev.sessionId;
            });
            emit({ type: "sessionInfo", sessionId: ev.sessionId, agent });
            break;
          case "activity":
            emit({ type: "activity", label: ev.label });
            break;
          case "notice":
            emit({ type: "info", text: ev.text });
            break;
          case "commands":
            // Реальный список команд CLI — кэшируем и обновляем меню.
            await this.context.globalState.update(CLAUDE_COMMANDS_KEY, ev.commands);
            this.post({ type: "slashCommands", agent, commands: ev.commands });
            break;
          case "models":
            // Актуальные модели CLI (+ effort-уровни) — в кэш для пикеров.
            await this.context.globalState.update(CLAUDE_MODELS_KEY, ev.models);
            await this.context.globalState.update(CLAUDE_MODELS_AT_KEY, Date.now());
            break;
          case "question": {
            // Это асинхронный вопрос из agentMessage, не ожидающий RPC ответа.
            // Настоящие request_user_input проходят только через confirmTool.
            delivered = true;
            const origin: QuestionOrigin = {
              chatId: runKey,
              recordId: record.id, createdAt: recordGen, sessionId: currentSessionId,
            };
            const questionNonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            for (const [i, q] of ev.questions.entries()) {
              const requestId = `codexq-${ev.id || "question"}-${questionNonce}-${i}`;
              emit({
                type: "permissionRequest",
                requestId,
                toolName: "request_user_input",
                inputPreview: "",
                kind: "question",
                question: q.title,
                options: q.options,
              });
              this.pendingPermissions.set(requestId, {
                path: cwd,
                chatId,
                recordId: record.id,
                resolve: async (res) => {
                  if (!res.answer?.trim()) return;
                  if (!this.isQuestionOriginCurrent(cwd, agent, origin)) {
                    this.reportExpiredQuestion(cwd, chatId);
                    return;
                  }
                  const text = `Ответ на твой вопрос «${q.title.slice(0, 160)}»: ${res.answer}`;
                  const handler = this.runs.get(runKey) === controller &&
                    !controller.signal.aborted && this.steers.get(runKey) === steer ? steer.handler : undefined;
                  if (!handler) {
                    if (this.deferTurn(cwd, agent, text, origin, chatId)) {
                      emit({ type: "info", text: "Живой канал исходного хода недоступен. Ответ отправится отдельным ходом в этой же сессии." });
                    }
                    return;
                  }
                  try {
                    await handler(text, "next");
                  } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    if (!this.isQuestionOriginCurrent(cwd, agent, origin)) return;
                    // Только явный отказ до отправки допускает повторный ход.
                    // Неизвестная ошибка связи могла произойти уже после приёма.
                    if (/^ход уже заверш[её]н$/i.test(message) && !controller.signal.aborted) {
                      if (this.deferTurn(cwd, agent, text, origin, chatId)) {
                        emit({ type: "info", text: "Исходный ход уже завершён. Ответ отправится отдельным ходом в этой же сессии." });
                      }
                    } else {
                      emit({
                        type: "info",
                        text: "Доставка ответа не подтверждена. Автоматический повтор отключён, чтобы не отправить ответ дважды. При необходимости уточните у агента вручную.",
                      });
                    }
                    return;
                  }
                  if (this.isQuestionOriginCurrent(cwd, agent, origin)) {
                    emit({ type: "userMessage", text });
                    emit({ type: "info", text: "Ответ передан агенту в текущий ход." });
                  }
                  if (turnLogDone) {
                    // ACK мог прийти после финального лога и начала нового хода.
                    // Пишем только в исходную запись, не в общий steerTexts map.
                    await turnLogDone;
                    await mutateTurnRecord((r) => {
                      (r.chatLog ??= []).push({ agent, role: "user", text: clipLog(text) });
                    });
                  } else {
                    questionAnswers.push(text);
                  }
                },
              });
              answerBuf = answerBuf ? `${answerBuf}\n\n${q.title}` : q.title;
            }
            emit({
              type: "info",
              text: "Агент задал вопрос и продолжает работу. Ответ будет передан в текущий ход, если транспорт принимает сообщения на лету; иначе — следующим ходом.",
            });
            this.revealUi();
            this.notifyBackgroundPermission(cwd, "Codex задаёт вопрос", chatId);
            break;
          }
          case "contextUsage":
            await mutateTurnRecord((r) => {
              r.context = { ...r.context, [agent]: { used: ev.usedTokens, max: ev.maxTokens } };
            });
            emit({ type: "contextUsage", agent, used: ev.usedTokens, max: ev.maxTokens });
            break;
          case "model":
            await mutateTurnRecord((r) => {
              r.models = { ...r.models, [agent]: ev.model };
              r.modelFallbacks = { ...r.modelFallbacks, [agent]: ev.fallbackFrom ?? undefined };
            });
            emit({ type: "modelInfo", agent, model: ev.model, fallbackFrom: ev.fallbackFrom });
            break;
          case "textDelta":
            delivered = true;
            answerBuf += ev.text;
            emit({ type: "textDelta", text: ev.text });
            break;
          case "assistantText":
            delivered = true;
            answerBuf = answerBuf ? `${answerBuf}\n\n${ev.text}` : ev.text;
            emit({ type: "assistantText", text: ev.text });
            break;
          case "toolUse":
            delivered = true;
            emit({ type: "toolUse", toolName: ev.toolName, summary: ev.summary });
            break;
          case "result":
            turnSucceeded = ev.ok;
            if (ev.ok) delivered = true;
            emit({
              type: "turnResult",
              ok: ev.ok,
              costUsd: ev.costUsd,
              durationMs: ev.durationMs,
              numTurns: ev.numTurns,
            });
            break;
          case "error":
            emit({ type: "error", message: ev.message });
            break;
        }
      }
      // Ошибка подключения/восстановления не должна коммитить посторонние правки.
      if (turnSucceeded && !controller.signal.aborted) {
        if (group.overlapped) {
          emit({ type: "info", text: "В этой папке одновременно работали несколько чатов: автоcommit и автопуш пропущены. Проверьте общий diff после завершения всех запусков." });
        } else {
          const operation = this.autoCommit(workingDir, agent, prompt, cwd, chatId);
          group.gitOperation = operation;
          await operation;
          if (group.gitOperation === operation) group.gitOperation = undefined;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) {
        emit({ type: "error", message });
      } else {
        emit({ type: "info", text: "Остановлено." });
      }
    } finally {
      this.steers.delete(runKey);
      const steered = [...(this.steerTexts.get(runKey) ?? []), ...questionAnswers];
      this.steerTexts.delete(runKey);
      // Общий лог беседы — зеркало видимой ленты: из него другой агент получит
      // контекст. Отметку «видел до сих пор» двигаем, только если промпт реально
      // дошёл до агента; свои же сообщения агенту не пересылаются (фильтр выше).
      const answer = answerBuf.trim();
      // Вложения — частью записи: другой агент должен видеть пути файлов.
      const logUserText = attachBlock ? `${prompt}\n\n${attachBlock}` : prompt;
      turnLogDone = mutateTurnRecord((r) => {
        const log = (r.chatLog ??= []);
        if (echoUser) log.push({ agent, role: "user", text: clipLog(logUserText) });
        for (const t of steered) log.push({ agent, role: "user", text: clipLog(t) });
        if (answer) log.push({ agent, role: "assistant", text: clipLog(answer) });
        const seen: Partial<Record<AgentId, number>> = { ...(r.chatSeen ?? {}) };
        if (delivered && !isSlashCommand) seen[agent] = log.length;
        const overflow = log.length - CHAT_LOG_MAX_ENTRIES;
        if (overflow > 0) {
          log.splice(0, overflow);
          for (const key of Object.keys(seen) as AgentId[]) {
            seen[key] = Math.max(0, (seen[key] ?? 0) - overflow);
          }
        }
        r.chatSeen = seen;
      });
      await turnLogDone;
      if (this.runs.get(runKey) === controller) this.runs.delete(runKey);
      // Отложенный ход (ответ на вопрос Codex) — без промежуточного busy:false,
      // иначе очередь webview стартует параллельно и упрётся в «агент работает».
      for (;;) {
        nextDeferred = this.deferred.get(runKey)?.shift();
        if (!nextDeferred?.questionOrigin ||
          this.isQuestionOriginCurrent(cwd, nextDeferred.agent, nextDeferred.questionOrigin)) break;
        this.reportExpiredQuestion(cwd, chatId);
      }
      if (!nextDeferred) emit({ type: "busy", value: false });
    }
    releaseDirectory();
    if (nextDeferred) {
      // The queued answer resumes this CLI session, so release this turn's writer first.
      releaseWriter();
      await this.runTurn(nextDeferred.prompt, nextDeferred.agent, [], cwd, true, nextDeferred.questionOrigin, nextDeferred.chatId);
    }
    } finally {
      releaseWriter();
      releaseDirectory();
      if (this.runs.get(runKey) === controller) {
        this.runs.delete(runKey);
        emit({ type: "busy", value: false });
      }
    }
  }

  /**
   * «Завершить сессию» (раздел 8.4): агент пишет резюме в журнал и коммитит,
   * затем session id сбрасываются — следующее сообщение начнёт новую сессию,
   * которая подхватит журнал. Лента чата при этом не очищается.
   */
  private async finishSession(agent: AgentId, chatId?: string) {
    const slot = this.findChatSlot(chatId);
    const project = slot
      ? this.getProjects().find((entry) => projectKey(entry) === slot.projectPath)
      : this.getActiveProject();
    if (!project) return;
    const runKey = chatId ?? projectKey(project);
    if (this.runs.has(runKey) || (this.directoryRuns?.get(physicalDirectory(project.path))?.controllers.size ?? 0) > 0) {
      this.postScoped(projectKey(project), { type: "error", message: "В этой папке агент ещё работает. Дождитесь завершения всех чатов." }, chatId);
      return;
    }

    const cfg = vscode.workspace.getConfiguration("agentHub");
    const dir = cfg.get<string>("journalDir", "docs/journal");

    this.postScoped(projectKey(project), { type: "info", text: "Записываю итоги сессии в журнал…" }, chatId);
    await this.runTurn(buildFinishPrompt(dir), agent, [], projectKey(project), true, undefined, chatId);

    const clearIds = (r: SessionRecord) => {
      r.agentIds = { claude: null, codex: null };
    };
    if (slot) await this.mutateRecord(slot.projectPath, slot.recordId, clearIds);
    else await this.mutateActiveRecord(projectKey(project), clearIds);
    // Пользователь мог переключиться на другой проект за время хода —
    // адресуем завершение проекту, где писались итоги.
    this.postScoped(projectKey(project), { type: "sessionInfo", sessionId: null, agent: "claude" }, chatId);
    this.postScoped(projectKey(project), { type: "sessionInfo", sessionId: null, agent: "codex" }, chatId);
    this.postScoped(projectKey(project), {
      type: "info",
      text: "Итоги записаны. Следующее сообщение начнёт новую сессию с контекстом из журнала.",
    }, chatId);
  }

  /**
   * Подтверждение инструмента карточкой в webview.
   * AskUserQuestion — особый случай: это вопрос агента, а не разрешение;
   * рендерится карточкой с вариантами ответа.
   */
  private async confirmTool(
    toolName: string,
    input: unknown,
    cwd: string,
    chatId?: string,
    recordId?: string,
  ): Promise<{ allow: boolean; answer?: string }> {
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    if (toolName === "AskUserQuestion") {
      const q = (input as {
        questions?: { question?: string; options?: { label?: string; description?: string }[] }[];
      } | null)?.questions?.[0];
      this.postScoped(cwd, {
        type: "permissionRequest",
        requestId,
        toolName,
        inputPreview: "",
        kind: "question",
        question: q?.question ?? "Агент задаёт вопрос (см. детали).",
        options: (q?.options ?? [])
          .filter((o) => typeof o?.label === "string")
          .map((o) => ({ label: o.label as string, description: o.description })),
      }, chatId);
      this.postScoped(cwd, { type: "activity", label: "Ждёт вашего ответа…" }, chatId);
      this.revealUi();
      this.notifyBackgroundPermission(cwd, "агент задаёт вопрос", chatId);
      return new Promise((resolve) =>
        this.pendingPermissions.set(requestId, { path: cwd, chatId, recordId, resolve }),
      );
    }

    if (this.isAutoAllowed(toolName, input)) {
      return { allow: true };
    }

    this.postScoped(cwd, {
      type: "permissionRequest",
      requestId,
      toolName,
      inputPreview: formatInputPreview(input),
      kind: "tool",
    }, chatId);
    this.postScoped(cwd, { type: "activity", label: "Ждёт подтверждения…" }, chatId);
    // Панель может быть скрыта — покажем её, иначе агент будет ждать вечно.
    this.revealUi();
    this.notifyBackgroundPermission(cwd, `нужно подтверждение: ${toolName}`, chatId);

    return new Promise((resolve) =>
      this.pendingPermissions.set(requestId, { path: cwd, chatId, recordId, resolve }),
    );
  }

  /** Карточка ждёт в ФОНОВОМ проекте — иначе пользователь её не увидит. */
  private notifyBackgroundPermission(cwd: string, what: string, chatId?: string) {
    if (chatId && this.multiPanel) return;
    if (this.getActiveProjectKey() === cwd) return;
    const name = this.getProjects().find((p) => projectKey(p) === cwd)?.name ?? nodePath.basename(cwd);
    void vscode.window
      .showWarningMessage(`Agent Hub — проект «${name}»: ${what}`, "Открыть проект")
      .then(async (choice) => {
        if (choice === "Открыть проект") {
          await this.setActivePath(cwd);
          this.postFullState();
          this.revealUi();
        }
      });
  }

  /** Allowlist из настроек: имена инструментов и префиксы bash-команд (раздел 8.5). */
  private isAutoAllowed(toolName: string, input: unknown): boolean {
    const cfg = vscode.workspace.getConfiguration("agentHub");
    const tools = cfg.get<string[]>("autoAllowTools", []);
    if (tools.includes(toolName)) return true;

    if (toolName === "Bash") {
      const prefixes = cfg.get<string[]>("autoAllowBash", []);
      const command = (input as { command?: unknown } | null)?.command;
      if (typeof command === "string") {
        return prefixes.some(
          (p) => command === p || command.startsWith(p.endsWith(" ") ? p : p + " "),
        );
      }
    }
    return false;
  }

  dispose() {
    this.denyAllPending();
    this.abortAll();
    this.runs.clear();
  }

  private renderHtml(webview: vscode.Webview, surface: "view" | "panel" | "multi-panel"): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"),
    );
    const nonce = Math.random().toString(36).slice(2);

    return /* html */ `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Agent Hub</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__AGENT_HUB_SURFACE__ = "${surface}";</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
