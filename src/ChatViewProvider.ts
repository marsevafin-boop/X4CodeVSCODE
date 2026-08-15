import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import type {
  AgentId,
  Attachment,
  HostToWebview,
  ProjectInfo,
  WebviewToHost,
} from "./shared/protocol";
import type { AgentBackend } from "./agents/types";
import { ClaudeBackend } from "./agents/claudeBackend";
import { CodexBackend } from "./agents/codexBackend";
import { buildFinishPrompt, readJournalContext } from "./journal";

const LEGACY_SESSIONS_KEY = "agentHub.sessions";
const LEGACY_TRANSCRIPTS_KEY = "agentHub.transcripts";
const STORE_KEY = "agentHub.sessionStore";
const ACTIVE_PROJECT_KEY = "agentHub.activeProject";
const TRANSCRIPT_MAX_ITEMS = 300;
const MAX_SESSIONS_PER_PROJECT = 30;

type ProjectSessions = Record<AgentId, string | null>;

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
      name: typeof p.name === "string" && p.name ? p.name : nodePath.basename(p.path),
      path: p.path,
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

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "agentHub.chat";

  private view?: vscode.WebviewView;
  /** Полноэкранный режим: тот же чат вкладкой редактора; работает синхронно с сайдбаром. */
  private panel: vscode.WebviewPanel | null = null;
  private readonly backends: Record<AgentId, AgentBackend> = {
    claude: new ClaudeBackend(),
    codex: new CodexBackend(),
  };
  /** Запущенные ходы по проектам: путь → контроллер. Разные проекты — параллельно. */
  private runs = new Map<string, AbortController>();
  /** Ожидающие решения запросы canUseTool: requestId → {проект, resolve}. */
  private pendingPermissions = new Map<
    string,
    { path: string; resolve: (result: { allow: boolean; answer?: string }) => void }
  >();

  /** Сообщение с меткой проекта — webview маршрутизирует в свою ленту. */
  private postScoped(path: string, msg: HostToWebview) {
    this.post({ ...msg, path } as HostToWebview);
  }

  /** После изменения реестра: остановить ходы проектов, которых больше нет. */
  private abortOrphanRuns() {
    const known = new Set(this.getProjects().map((p) => p.path));
    for (const [path, controller] of [...this.runs]) {
      if (!known.has(path)) {
        controller.abort();
        this.denyAllPending(path);
      }
    }
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg));
  }

  // ---------- Проекты ----------

  /** Реестр: настройки agentHub.projects + папки открытого workspace. */
  private getProjects(): ProjectInfo[] {
    const cfg = vscode.workspace.getConfiguration("agentHub");
    const configured = cfg.get<ProjectInfo[]>("projects", []) ?? [];
    const projects: ProjectInfo[] = [];
    const seen = new Set<string>();

    for (const p of configured) {
      if (!p || typeof p.path !== "string" || !p.path) continue;
      const path = p.path.replace(/^~(?=\/|$)/, os.homedir());
      if (seen.has(path)) continue;
      seen.add(path);
      projects.push({
        name: p.name || nodePath.basename(path),
        path,
        githubRepo: p.githubRepo,
        branch: p.branch,
        serverHost: p.serverHost,
        serverProtocol: p.serverProtocol,
        serverPort: p.serverPort,
        serverUser: p.serverUser,
        server: p.server,
      });
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const path = folder.uri.fsPath;
      if (!seen.has(path)) {
        seen.add(path);
        projects.push({ name: folder.name, path });
      }
    }
    return projects;
  }

  private getActiveProject(): ProjectInfo | null {
    const projects = this.getProjects();
    const saved = this.context.globalState.get<string>(ACTIVE_PROJECT_KEY);
    return projects.find((p) => p.path === saved) ?? projects[0] ?? null;
  }

  /** Ключ пароля сервера в SecretStorage (системный Keychain). */
  private passwordKey(projectPath: string): string {
    return `agentHub.serverPassword:${projectPath}`;
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
    const path = picked[0].fsPath;

    const cfg = vscode.workspace.getConfiguration("agentHub");
    const list = [...(cfg.get<ProjectInfo[]>("projects", []) ?? [])];
    const existing = list.findIndex((p) => p.path === path);
    if (existing < 0) {
      list.push({ name: nodePath.basename(path), path });
      await cfg.update("projects", list, vscode.ConfigurationTarget.Global);
    }
    await this.context.globalState.update(ACTIVE_PROJECT_KEY, path);
    this.postFullState();
    await this.postSettings();
    // Открываем экран настроек панели: название, GitHub, ветка, сервер,
    // пароль — всё заполняется там, без риска потерять ввод.
    this.post({ type: "openSettingsScreen" });
    this.post({
      type: "info",
      text: `Проект «${nodePath.basename(path)}» добавлен и выбран. Заполните детали в настройках (⚙) и нажмите «Сохранить».`,
    });
  }

  /**
   * Удаление проекта: «убрать из списка» (файлы не трогаем, история сессий
   * сохраняется на случай возврата) или «удалить с диска» (папка — в Корзину,
   * пароль и история сессий вычищаются).
   */
  async deleteProject(path: string) {
    const project = this.getProjects().find((p) => p.path === path);
    if (!project) return;
    const isWorkspaceFolder = (vscode.workspace.workspaceFolders ?? []).some(
      (f) => f.uri.fsPath === path,
    );

    const LIST_ONLY = "Убрать из списка";
    const WITH_FOLDER = "Удалить вместе с папкой";
    const choice = await vscode.window.showWarningMessage(
      `Удалить проект «${project.name}»?`,
      {
        modal: true,
        detail:
          `${path}\n\n«${LIST_ONLY}» — файлы не трогаем, историю сессий сохраняем.\n` +
          `«${WITH_FOLDER}» — папка отправится в Корзину, история и пароль будут удалены.`,
      },
      LIST_ONLY,
      WITH_FOLDER,
    );
    if (!choice) return;

    if (choice === WITH_FOLDER && isWorkspaceFolder) {
      void vscode.window.showErrorMessage(
        `Папка «${project.name}» открыта в текущем workspace — сначала закройте её (File → Remove Folder from Workspace), потом удаляйте с диска.`,
      );
      return;
    }

    if (choice === WITH_FOLDER) {
      const confirm = await vscode.window.showWarningMessage(
        `Точно удалить папку с диска?`,
        { modal: true, detail: `${path}\n\nПапка будет отправлена в Корзину (восстановимо).` },
        "Да, удалить папку",
      );
      if (confirm !== "Да, удалить папку") return;
    }

    // Останавливаем ход проекта и снимаем зависшие подтверждения.
    this.runs.get(path)?.abort();
    this.denyAllPending(path);

    // Из реестра — в любом случае.
    const cfg = vscode.workspace.getConfiguration("agentHub");
    const list = (cfg.get<ProjectInfo[]>("projects", []) ?? []).filter(
      (p) => p.path?.replace(/^~(?=\/|$)/, os.homedir()) !== path,
    );
    await cfg.update("projects", list, vscode.ConfigurationTarget.Global);
    if (this.context.globalState.get<string>(ACTIVE_PROJECT_KEY) === path) {
      await this.context.globalState.update(ACTIVE_PROJECT_KEY, undefined);
    }

    if (choice === WITH_FOLDER) {
      // Пароль и историю сессий вычищаем вместе с папкой.
      await this.context.secrets.delete(this.passwordKey(path));
      const all = { ...this.getStoreAll() };
      delete all[path];
      await this.context.globalState.update(STORE_KEY, all);
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(path), {
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
            ? `Проект «${project.name}» убран из реестра, но папка открыта в workspace — она останется в списке, пока открыта.`
            : `Проект «${project.name}» убран из списка. Файлы и история сессий не тронуты.`,
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

    const cfg = vscode.workspace.getConfiguration("agentHub");
    const list = [...(cfg.get<ProjectInfo[]>("projects", []) ?? [])];
    const idx = list.findIndex(
      (p) => p.path?.replace(/^~(?=\/|$)/, os.homedir()) === active.path,
    );

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
      const entry: ProjectInfo = idx >= 0 ? { ...list[idx] } : { ...active };
      if (protoPick.value === "ssh") delete entry.serverProtocol;
      else entry.serverProtocol = protoPick.value;
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      await cfg.update("projects", list, vscode.ConfigurationTarget.Global);
      this.postFullState();
      this.post({ type: "info", text: `Протокол сервера: ${protoPick.label}.` });
      return;
    }

    if (pick.action === "delete") {
      await this.deleteProject(active.path);
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
    const entry: ProjectInfo = idx >= 0 ? { ...list[idx] } : { ...active };
    if (value) {
      (entry as unknown as Record<string, unknown>)[field.key] =
        field.key === "serverPort" ? parseInt(value, 10) : value;
    } else if (field.key === "name") {
      entry.name = nodePath.basename(active.path);
    } else {
      delete (entry as unknown as Record<string, unknown>)[field.key];
    }
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);

    await cfg.update("projects", list, vscode.ConfigurationTarget.Global);
    this.postFullState();
    this.post({ type: "info", text: `Проект обновлён: ${field.label.toLowerCase()}.` });
  }

  // ---------- Проверка соединения с сервером ----------

  /**
   * Проверка соединения по выбранному протоколу.
   * SSH/SFTP: сначала ключи (BatchMode), затем пароль через sshpass (env SSHPASS).
   * FTP: curl, логин/пароль уходят через конфиг на stdin (-K -), не в argv.
   */
  private async testServer(
    host: string,
    user?: string,
    formPassword?: string,
    protocol: "ssh" | "sftp" | "ftp" = "ssh",
    port?: number,
  ) {
    const target = user ? `${user}@${host}` : host;
    const shortErr = (s: string) => {
      const line = s.trim().split("\n").filter(Boolean).pop() ?? "неизвестная ошибка";
      return line.length > 220 ? line.slice(0, 220) + "…" : line;
    };
    const report = (ok: boolean, message: string) =>
      this.post({ type: "serverTestResult", ok, message });

    const spawnRun = (
      cmd: string,
      args: string[],
      opts?: { stdin?: string; env?: NodeJS.ProcessEnv },
    ): Promise<{ code: number; out: string; err: string; timedOut: boolean }> =>
      new Promise((resolve) => {
        const child = spawn(cmd, args, { env: opts?.env ?? process.env });
        let out = "";
        let err = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, 15000);
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        child.on("error", (e: Error) => {
          clearTimeout(timer);
          resolve({ code: 127, out, err: String(e), timedOut });
        });
        child.on("close", (code: number | null) => {
          clearTimeout(timer);
          resolve({ code: code ?? 1, out, err, timedOut });
        });
        if (opts?.stdin !== undefined) child.stdin.write(opts.stdin);
        child.stdin.end();
      });

    const project = this.getActiveProject();
    const password =
      formPassword ||
      (project ? await this.context.secrets.get(this.passwordKey(project.path)) : undefined);

    // ---------- FTP ----------
    if (protocol === "ftp") {
      const hostPort = `${host}:${port ?? 21}`;
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const config = [
        `url = "ftp://${hostPort}/"`,
        `user = "${esc(user ?? "anonymous")}:${esc(password ?? "")}"`,
        "list-only",
        "connect-timeout = 8",
        "silent",
        "show-error",
      ].join("\n");
      const r = await spawnRun("curl", ["--max-time", "15", "-K", "-"], { stdin: config });
      if (r.code === 0) {
        const entries = r.out.split("\n").filter(Boolean).length;
        report(true, `FTP ${hostPort} — соединение и логин OK (в корне записей: ${entries})`);
      } else if (r.timedOut || r.code === 28) {
        report(false, `FTP ${hostPort} — таймаут: хост недоступен или порт закрыт.`);
      } else if (r.code === 67) {
        report(false, `FTP ${hostPort} — сервер отверг логин/пароль.`);
      } else if (r.code === 6 || r.code === 7) {
        report(false, `FTP ${hostPort} — хост не найден или соединение отклонено.`);
      } else {
        report(false, `FTP ${hostPort} — ошибка: ${shortErr(r.err)}`);
      }
      return;
    }

    // ---------- SSH / SFTP ----------
    const isSftp = protocol === "sftp";
    const portArgs = port ? (isSftp ? ["-P", String(port)] : ["-p", String(port)]) : [];
    const commonOpts = [
      "-o", "ConnectTimeout=8",
      "-o", "StrictHostKeyChecking=accept-new",
    ];
    const probe = "echo AGENT_HUB_OK && uname -sr";

    // 1) Ключи / алиас из ~/.ssh/config.
    const key = isSftp
      ? await spawnRun("sftp", ["-o", "BatchMode=yes", ...commonOpts, ...portArgs, "-b", "/dev/null", target])
      : await spawnRun("ssh", ["-o", "BatchMode=yes", ...commonOpts, ...portArgs, target, probe]);
    const keyOk = isSftp ? key.code === 0 : key.out.includes("AGENT_HUB_OK");
    if (keyOk) {
      const uname = key.out.split("\n").map((l) => l.trim()).filter((l) => l && l !== "AGENT_HUB_OK")[0];
      report(true, `${protocol.toUpperCase()} ${target} — доступ по SSH-ключу${uname ? ` · ${uname}` : ""}`);
      return;
    }
    if (key.timedOut) {
      report(false, `${target} — таймаут соединения (8 с): хост недоступен или порт закрыт.`);
      return;
    }

    // 2) Пароль через sshpass.
    if (!password) {
      report(false, `${target} — по ключу не подключилось: ${shortErr(key.err)}`);
      return;
    }
    const which = await spawnRun("which", ["sshpass"]);
    if (which.code !== 0) {
      report(
        false,
        `${target} — ключи не сработали, а для проверки по паролю нужен sshpass ` +
          `(brew install esolitos/ipa/sshpass). Надёжнее настроить SSH-ключи: ssh-copy-id ${target}`,
      );
      return;
    }

    const env = { ...process.env, SSHPASS: password };
    const pw = isSftp
      ? await spawnRun(
          "sshpass",
          ["-e", "sftp", "-o", "BatchMode=no", ...commonOpts, ...portArgs, "-b", "-", target],
          { stdin: "bye\n", env },
        )
      : await spawnRun(
          "sshpass",
          [
            "-e", "ssh",
            ...commonOpts,
            "-o", "PreferredAuthentications=password,keyboard-interactive",
            ...portArgs,
            target,
            probe,
          ],
          { env },
        );
    const pwOk = isSftp ? pw.code === 0 : pw.out.includes("AGENT_HUB_OK");
    if (pwOk) {
      const uname = pw.out.split("\n").map((l) => l.trim()).filter((l) => l && l !== "AGENT_HUB_OK")[0];
      report(true, `${protocol.toUpperCase()} ${target} — доступ по паролю${uname && !isSftp ? ` · ${uname}` : ""}`);
      return;
    }
    report(
      false,
      pw.timedOut
        ? `${target} — таймаут при проверке по паролю.`
        : `${target} — не подключилось по паролю: ${shortErr(pw.err)}`,
    );
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
      // Реестр + папки workspace — на другой машине всё станет реестром.
      projects: this.getProjects(),
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
    if (Array.isArray(settings.autoAllowTools)) {
      await cfg.update("autoAllowTools", settings.autoAllowTools, g);
    }
    if (Array.isArray(settings.autoAllowBash)) {
      await cfg.update("autoAllowBash", settings.autoAllowBash, g);
    }
  }

  /**
   * Применить конфиг, отредактированный прямо в настройках (JSON-редактор).
   * Настройки перезаписываются; список проектов ЗАМЕНЯЕТСЯ целиком.
   */
  async applyConfigJson(json: string) {
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
      const list = normalizeProjects(settings.projects);
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

    const incoming = normalizeProjects(raw);

    let added = 0;
    let updated = 0;
    if (incoming.length > 0) {
      const list = [...(cfg.get<ProjectInfo[]>("projects", []) ?? [])];
      for (const p of incoming) {
        const idx = list.findIndex((e) => e.path === p.path);
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
      projects.map((p) => ({ label: p.name, description: p.serverHost ?? p.path, path: p.path })),
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
      await this.context.secrets.delete(this.passwordKey(pick.path));
      void vscode.window.showInformationMessage("Сохранённый пароль удалён.");
    }
  }

  /** Карточка проекта для контекста новой сессии. */
  private async buildProjectCard(p: ProjectInfo): Promise<string> {
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
      const hasPassword = Boolean(await this.context.secrets.get(this.passwordKey(p.path)));
      const passwordNote =
        "Пароль доступен в переменных окружения AGENT_HUB_SERVER_PASSWORD и LFTP_PASSWORD — " +
        "в текст диалога его никогда не выводи; sshpass -e и lftp --env-password берут его из окружения сами.";

      if (proto === "ssh") {
        const portFlag = p.serverPort ? ` -p ${p.serverPort}` : "";
        lines.push(`Сервер проекта: ${target}${p.serverPort ? `, порт ${p.serverPort}` : ""} (доступ по SSH).`);
        if (hasPassword) {
          lines.push(
            `${passwordNote} Для ssh с паролем: sshpass -e ssh${portFlag} ${target} '<команда>'. ` +
              `Если sshpass недоступен — предложи установить его или настроить SSH-ключи.`,
          );
        }
      } else if (proto === "sftp") {
        const portFlag = p.serverPort ? ` -P ${p.serverPort}` : "";
        lines.push(
          `Сервер проекта: SFTP ${target}${p.serverPort ? `, порт ${p.serverPort}` : ""}. ` +
            `Shell-доступа может не быть — работай передачей файлов.`,
        );
        lines.push(
          (hasPassword ? `${passwordNote} ` : "") +
            `Подключение: sshpass -e sftp${portFlag} ${target} (батч-команды через -b) ` +
            `или lftp --env-password -u ${p.serverUser ?? "user"} sftp://${p.serverHost}${p.serverPort ? `:${p.serverPort}` : ""}.`,
        );
      } else {
        const hostPort = `${p.serverHost}${p.serverPort ? `:${p.serverPort}` : ""}`;
        lines.push(`Сервер проекта: FTP ${hostPort}, логин ${p.serverUser ?? "anonymous"}.`);
        lines.push(
          (hasPassword ? `${passwordNote} ` : "") +
            `Работай через curl: скачать — curl --user '${p.serverUser ?? "anonymous"}:'"$AGENT_HUB_SERVER_PASSWORD" ftp://${hostPort}/путь -o файл; ` +
            `залить — curl -T файл --user '${p.serverUser ?? "anonymous"}:'"$AGENT_HUB_SERVER_PASSWORD" ftp://${hostPort}/папка/; ` +
            `листинг — тот же curl без -o/-T. Либо lftp --env-password -u ${p.serverUser ?? "anonymous"} ftp://${hostPort}.`,
        );
      }
    }
    if (p.server) lines.push(`Заметки о сервере: ${p.server}`);
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
  private pruneEmptySessions(store: ProjectStore) {
    store.sessions = store.sessions.filter(
      (s) => s.id === store.activeId || hasUserContent(s.items),
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

  /** Полное состояние для webview: проекты, лента активной сессии, session id. */
  private postFullState() {
    const projects = this.getProjects();
    const active = this.getActiveProject();
    this.post({ type: "projects", projects, activePath: active?.path ?? "" });
    if (active) {
      const rec = this.getActiveRecord(active.path);
      this.post({ type: "transcript", path: active.path, items: rec?.items ?? [] });
      // Скоуп обязателен: burst идёт до ре-рендера webview, и фолбэк на
      // activeRef разложил бы состояние под старым проектом (баг из ревью).
      this.postScoped(active.path, {
        type: "sessionInfo",
        sessionId: rec?.agentIds.claude ?? null,
        agent: "claude",
      });
      this.postScoped(active.path, {
        type: "sessionInfo",
        sessionId: rec?.agentIds.codex ?? null,
        agent: "codex",
      });
      for (const a of ["claude", "codex"] as const) {
        const ctx = rec?.context?.[a];
        this.postScoped(active.path, {
          type: "contextUsage",
          agent: a,
          used: ctx?.used ?? 0,
          max: ctx?.max ?? 0,
        });
        this.postScoped(active.path, {
          type: "modelInfo",
          agent: a,
          model: rec?.models?.[a] ?? "",
          fallbackFrom: rec?.modelFallbacks?.[a],
        });
      }
    }
    this.postSafety();
  }

  /** Настройки агента (модель, effort и т.п.) из VS Code settings. */
  private buildAgentConfig(agent: AgentId): import("./agents/types").AgentRunConfig {
    const cfg = vscode.workspace.getConfiguration(`agentHub.${agent}`);
    if (agent === "claude") {
      const cw = cfg.get<number>("contextWindow", 0);
      return {
        model: cfg.get<string>("model") || undefined,
        effort: cfg.get<string>("effort") || undefined,
        permissionMode: cfg.get<string>("permissionMode") || "default",
        maxTurns: cfg.get<number>("maxTurns") || 0,
        // 200000 — старый дефолт до v0.0.14, трактуем как «авто по модели».
        contextWindow: cw === 200000 ? 0 : cw,
      };
    }
    const cw = cfg.get<number>("contextWindow", 0);
    return {
      model: cfg.get<string>("model") || undefined,
      effort: cfg.get<string>("effort") || undefined,
      sandbox: cfg.get<string>("sandbox") || "workspace-write",
      yolo: cfg.get<boolean>("yolo") || false,
      contextWindow: cw === 400000 ? 0 : cw,
    };
  }

  // ---------- Настройки внутри панели ----------

  private async buildSettingsSnapshot(): Promise<import("./shared/protocol").SettingsSnapshot> {
    const cfg = vscode.workspace.getConfiguration("agentHub");
    const project = this.getActiveProject();
    const hasPassword = project
      ? (await this.context.secrets.get(this.passwordKey(project.path))) !== undefined
      : false;
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
      project,
      projectHasPassword: hasPassword,
    };
  }

  private async postSettings() {
    this.post({ type: "settings", settings: await this.buildSettingsSnapshot() });
    this.post({
      type: "configJson",
      json: JSON.stringify(this.collectAllSettings(), null, 2),
    });
  }

  private async applySettings(s: import("./shared/protocol").SettingsSave) {
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

    if (s.project) {
      const list = [...(cfg.get<ProjectInfo[]>("projects", []) ?? [])];
      const idx = list.findIndex(
        (p) => p.path?.replace(/^~(?=\/|$)/, os.homedir()) === s.project!.path,
      );
      const entry: ProjectInfo = {
        ...s.project,
        name: s.project.name || nodePath.basename(s.project.path),
      };
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      await cfg.update("projects", list, g);

      if (s.newPassword !== undefined) {
        if (s.newPassword) {
          await this.context.secrets.store(this.passwordKey(s.project.path), s.newPassword);
        } else {
          await this.context.secrets.delete(this.passwordKey(s.project.path));
        }
      }
    }

    this.postFullState();
    await this.postSettings();
    this.post({ type: "info", text: "Настройки сохранены." });
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
  async showSessions() {
    const project = this.getActiveProject();
    if (!project) return;
    if (this.runs.has(project.path)) {
      this.post({ type: "error", message: "В этом проекте идёт ход — дождитесь завершения." });
      return;
    }
    const store = this.getProjectStore(project.path);
    this.pruneEmptySessions(store);
    await this.saveProjectStore(project.path, store);
    if (store.sessions.length === 0) {
      this.post({ type: "info", text: "История сессий этого проекта пуста." });
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
          label: (s.id === store.activeId ? "$(circle-filled) " : "$(comment-discussion) ") + s.title,
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
      store.sessions = store.sessions.filter((s) => s.id !== rec.id);
      if (store.activeId === rec.id) {
        const latest = [...store.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        store.activeId = latest?.id ?? null;
      }
      await this.saveProjectStore(project.path, store);
      this.postFullState();
      if (store.sessions.length === 0) {
        qp.hide();
      } else {
        qp.items = toItems();
      }
    });

    qp.onDidAccept(async () => {
      const picked = qp.selectedItems[0];
      if (picked) {
        store.activeId = picked.sessionId;
        // Уходя с пустой сессии — не оставляем её в истории.
        this.pruneEmptySessions(store);
        await this.saveProjectStore(project.path, store);
        this.postFullState();
      }
      qp.hide();
    });

    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  // ---------- Управление сессиями ----------

  newSession() {
    const active = this.getActiveProject();
    if (active) {
      this.runs.get(active.path)?.abort();
      this.denyAllPending(active.path);
    }
    let keptPrevious = false;
    if (active) {
      const store = this.getProjectStore(active.path);
      const current = store.sessions.find((s) => s.id === store.activeId);
      if (current && !hasUserContent(current.items)) {
        // Пустую активную не сохраняем в историю — обнуляем и переиспользуем.
        current.items = [];
        current.agentIds = { claude: null, codex: null };
        current.title = "Новая сессия";
        current.createdAt = Date.now();
        current.updatedAt = Date.now();
        current.context = {};
        current.models = {};
      } else {
        keptPrevious = !!current;
        const rec = this.createRecord();
        store.sessions.push(rec);
        store.activeId = rec.id;
      }
      this.pruneEmptySessions(store);
      // Кап истории: держим самые свежие.
      store.sessions = [...store.sessions]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_SESSIONS_PER_PROJECT);
      void this.saveProjectStore(active.path, store);
    }
    this.postFullState();
    if (active) {
      this.postScoped(active.path, {
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
  }

  /** Показать чат пользователю: вкладка приоритетнее сайдбара. */
  private revealUi() {
    if (this.panel) this.panel.reveal(undefined, true);
    else this.view?.show?.(true);
  }

  /** «Во всю ширину»: чат вкладкой редактора + прячем сайдбар. */
  async openFullView() {
    if (this.panel) {
      this.panel.reveal();
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
    panel.webview.html = this.renderHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg));
    panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel = panel;
    // Сайдбар прячем — чат занимает всю ширину окна.
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    this.postFullState();
    await this.postSettings();
  }

  private async onMessage(msg: WebviewToHost) {
    switch (msg.type) {
      case "ready":
        this.postFullState();
        break;
      case "stop": {
        const requested = msg.path ?? this.getActiveProject()?.path;
        // Ищем, что останавливать: запрошенный проект → единственный запуск.
        const target =
          requested && this.runs.has(requested)
            ? requested
            : this.runs.size === 1
              ? [...this.runs.keys()][0]
              : undefined;
        if (target) {
          this.postScoped(target, { type: "activity", label: "Останавливаю…" });
          this.runs.get(target)?.abort();
          this.denyAllPending(target);
          // Страховка: бэкенд не завершился за 6 с — принудительно чистим UI.
          setTimeout(() => {
            if (this.runs.has(target)) {
              this.runs.delete(target);
              this.postScoped(target, { type: "busy", value: false });
              this.postScoped(target, {
                type: "error",
                message: "Ход остановлен принудительно: бэкенд не ответил на прерывание.",
              });
            }
          }, 6000);
        } else if (requested) {
          // Запусков нет, а UI считает проект занятым (рассинхрон после
          // перезагрузки) — «Стоп» приводит панель в порядок.
          this.denyAllPending(requested);
          this.postScoped(requested, { type: "busy", value: false });
        }
        break;
      }
      case "newSession":
        this.newSession();
        break;
      case "send":
        await this.runTurn(msg.text, msg.agent, msg.attachments ?? [], msg.path);
        break;
      case "pickAttachment": {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          openLabel: "Прикрепить",
        });
        if (picked?.length) {
          this.post({
            type: "attachmentAdded",
            files: picked.map((u) => ({ name: nodePath.basename(u.fsPath), path: u.fsPath })),
          });
        }
        break;
      }
      case "saveAttachment":
        await this.saveAttachment(msg.name, msg.dataBase64);
        break;
      case "finishSession":
        await this.finishSession(msg.agent);
        break;
      case "selectProject":
        await this.context.globalState.update(ACTIVE_PROJECT_KEY, msg.path);
        this.postFullState();
        break;
      case "addProject":
        await this.addProject();
        break;
      case "deleteProject":
        await this.deleteProject(msg.path);
        break;
      case "saveTranscript": {
        const store = this.getProjectStore(msg.path);
        const rec = store.sessions.find((s) => s.id === store.activeId);
        if (rec) {
          rec.items = msg.items.slice(-TRANSCRIPT_MAX_ITEMS);
          rec.updatedAt = Date.now();
          if (rec.title === "Новая сессия") {
            rec.title = deriveTitle(rec.items) ?? rec.title;
          }
          await this.saveProjectStore(msg.path, store);
        }
        break;
      }
      case "showSessions":
        await this.showSessions();
        break;
      case "openFullView":
        await this.openFullView();
        break;
      case "getSettings":
        await this.postSettings();
        break;
      case "exportSettings":
        await this.exportSettings();
        break;
      case "testServer":
        await this.testServer(msg.host, msg.user, msg.password, msg.protocol, msg.port);
        break;
      case "importSettings":
        await this.importSettings();
        break;
      case "applyConfigJson":
        await this.applyConfigJson(msg.json);
        break;
      case "saveSettings":
        await this.applySettings(msg.settings);
        break;
      case "cycleSafety":
        await this.cycleSafety(msg.agent);
        break;
      case "permission": {
        const pending = this.pendingPermissions.get(msg.requestId);
        if (pending) {
          this.pendingPermissions.delete(msg.requestId);
          pending.resolve({ allow: msg.allow, answer: msg.answer });
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
  private async saveAttachment(name: string, dataBase64: string) {
    const project = this.getActiveProject();
    if (!project) {
      this.post({ type: "error", message: "Нет активного проекта — некуда сохранить вложение." });
      return;
    }
    try {
      const dir = nodePath.join(project.path, ".agent-hub", "attachments");
      await fs.promises.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const safeName = name.replace(/[^\wа-яА-ЯёЁ.\-]+/g, "_") || "file";
      const filePath = nodePath.join(dir, `${stamp}-${safeName}`);
      await fs.promises.writeFile(filePath, Buffer.from(dataBase64, "base64"));
      this.post({
        type: "attachmentAdded",
        files: [{ name: nodePath.basename(filePath), path: filePath }],
      });
    } catch (err) {
      this.post({
        type: "error",
        message: `Не удалось сохранить вложение: ${err instanceof Error ? err.message : err}`,
      });
    }
  }

  /** Отклонить зависшие подтверждения: по проекту или все (path не задан). */
  private denyAllPending(path?: string) {
    for (const [requestId, pending] of [...this.pendingPermissions]) {
      if (path && pending.path !== path) continue;
      pending.resolve({ allow: false });
      this.pendingPermissions.delete(requestId);
      this.postScoped(pending.path, { type: "permissionResolved", requestId, allow: false });
    }
  }

  private async runTurn(
    prompt: string,
    agent: AgentId,
    attachments: Attachment[] = [],
    targetPath?: string,
  ) {
    const project = targetPath
      ? (this.getProjects().find((p) => p.path === targetPath) ?? null)
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
    const cwd = project.path;
    if (this.runs.has(cwd)) {
      this.postScoped(cwd, {
        type: "error",
        message: `В проекте «${project.name}» агент ещё работает. Дождитесь ответа или нажмите «Стоп».`,
      });
      return;
    }
    if (!fs.existsSync(cwd)) {
      this.postScoped(cwd, { type: "error", message: `Папка проекта не найдена: ${cwd}` });
      return;
    }

    const controller = new AbortController();
    this.runs.set(cwd, controller);
    this.postScoped(cwd, { type: "busy", value: true });
    this.postScoped(cwd, { type: "activity", label: "Запускается…" });

    // Вложения идут вместе с текстом сообщения — блок путей перед задачей.
    const promptWithAttachments =
      attachments.length > 0 ? `${buildAttachmentsBlock(attachments)}\n\n${prompt}` : prompt;

    // Новая сессия — карточка проекта + контекст из журнала (общая память).
    const record = await this.ensureActiveRecord(cwd);
    const sessions = record.agentIds;
    let fullPrompt = promptWithAttachments;
    if (!sessions[agent]) {
      const cfg = vscode.workspace.getConfiguration("agentHub");
      const parts: string[] = [await this.buildProjectCard(project)];
      const journalContext = await readJournalContext(
        cwd,
        cfg.get<string>("journalDir", "docs/journal"),
        cfg.get<number>("journalContextEntries", 3),
      );
      if (journalContext) {
        parts.push(journalContext);
        this.postScoped(cwd, { type: "info", text: "В контекст добавлены записи журнала сессий." });
      }
      parts.push(`Задача пользователя:\n${promptWithAttachments}`);
      fullPrompt = parts.join("\n\n");
    }

    // Пароль сервера — только через окружение, никогда в тексте диалога.
    const serverPassword = await this.context.secrets.get(this.passwordKey(project.path));

    try {
      const events = this.backends[agent].start(fullPrompt, {
        cwd,
        resumeSessionId: sessions[agent] ?? undefined,
        signal: controller.signal,
        extraEnv: serverPassword
          ? { AGENT_HUB_SERVER_PASSWORD: serverPassword, LFTP_PASSWORD: serverPassword }
          : undefined,
        config: this.buildAgentConfig(agent),
        attachments: attachments.map((a) => ({ path: a.path, isImage: isImagePath(a.path) })),
        confirmTool: (toolName, input) => this.confirmTool(toolName, input, cwd),
      });

      for await (const ev of events) {
        switch (ev.kind) {
          case "session":
            await this.mutateActiveRecord(cwd, (r) => {
              r.agentIds[agent] = ev.sessionId;
            });
            this.postScoped(cwd, { type: "sessionInfo", sessionId: ev.sessionId, agent });
            break;
          case "activity":
            this.postScoped(cwd, { type: "activity", label: ev.label });
            break;
          case "notice":
            this.postScoped(cwd, { type: "info", text: ev.text });
            break;
          case "contextUsage":
            await this.mutateActiveRecord(cwd, (r) => {
              r.context = { ...r.context, [agent]: { used: ev.usedTokens, max: ev.maxTokens } };
            });
            this.postScoped(cwd, { type: "contextUsage", agent, used: ev.usedTokens, max: ev.maxTokens });
            break;
          case "model":
            await this.mutateActiveRecord(cwd, (r) => {
              r.models = { ...r.models, [agent]: ev.model };
              r.modelFallbacks = { ...r.modelFallbacks, [agent]: ev.fallbackFrom ?? undefined };
            });
            this.postScoped(cwd, { type: "modelInfo", agent, model: ev.model, fallbackFrom: ev.fallbackFrom });
            break;
          case "textDelta":
            this.postScoped(cwd, { type: "textDelta", text: ev.text });
            break;
          case "assistantText":
            this.postScoped(cwd, { type: "assistantText", text: ev.text });
            break;
          case "toolUse":
            this.postScoped(cwd, { type: "toolUse", toolName: ev.toolName, summary: ev.summary });
            break;
          case "result":
            this.postScoped(cwd, {
              type: "turnResult",
              ok: ev.ok,
              costUsd: ev.costUsd,
              durationMs: ev.durationMs,
              numTurns: ev.numTurns,
            });
            break;
          case "error":
            this.postScoped(cwd, { type: "error", message: ev.message });
            break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) {
        this.postScoped(cwd, { type: "error", message });
      } else {
        this.postScoped(cwd, { type: "info", text: "Остановлено." });
      }
    } finally {
      this.runs.delete(cwd);
      this.postScoped(cwd, { type: "busy", value: false });
    }
  }

  /**
   * «Завершить сессию» (раздел 8.4): агент пишет резюме в журнал и коммитит,
   * затем session id сбрасываются — следующее сообщение начнёт новую сессию,
   * которая подхватит журнал. Лента чата при этом не очищается.
   */
  private async finishSession(agent: AgentId) {
    const project = this.getActiveProject();
    if (!project) return;
    if (this.runs.has(project.path)) {
      this.post({ type: "error", message: "В этом проекте агент ещё работает. Дождитесь ответа или нажмите «Стоп»." });
      return;
    }

    const cfg = vscode.workspace.getConfiguration("agentHub");
    const dir = cfg.get<string>("journalDir", "docs/journal");

    this.post({ type: "info", text: "Записываю итоги сессии в журнал…" });
    await this.runTurn(buildFinishPrompt(dir), agent);

    await this.mutateActiveRecord(project.path, (r) => {
      r.agentIds = { claude: null, codex: null };
    });
    // Пользователь мог переключиться на другой проект за время хода —
    // адресуем завершение проекту, где писались итоги.
    this.postScoped(project.path, { type: "sessionInfo", sessionId: null, agent: "claude" });
    this.postScoped(project.path, { type: "sessionInfo", sessionId: null, agent: "codex" });
    this.postScoped(project.path, {
      type: "info",
      text: "Итоги записаны. Следующее сообщение начнёт новую сессию с контекстом из журнала.",
    });
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
      });
      this.postScoped(cwd, { type: "activity", label: "Ждёт вашего ответа…" });
      this.revealUi();
      this.notifyBackgroundPermission(cwd, "агент задаёт вопрос");
      return new Promise((resolve) =>
        this.pendingPermissions.set(requestId, { path: cwd, resolve }),
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
    });
    this.postScoped(cwd, { type: "activity", label: "Ждёт подтверждения…" });
    // Панель может быть скрыта — покажем её, иначе агент будет ждать вечно.
    this.revealUi();
    this.notifyBackgroundPermission(cwd, `нужно подтверждение: ${toolName}`);

    return new Promise((resolve) =>
      this.pendingPermissions.set(requestId, { path: cwd, resolve }),
    );
  }

  /** Карточка ждёт в ФОНОВОМ проекте — иначе пользователь её не увидит. */
  private notifyBackgroundPermission(cwd: string, what: string) {
    if (this.getActiveProject()?.path === cwd) return;
    const name = this.getProjects().find((p) => p.path === cwd)?.name ?? nodePath.basename(cwd);
    void vscode.window
      .showWarningMessage(`Agent Hub — проект «${name}»: ${what}`, "Открыть проект")
      .then(async (choice) => {
        if (choice === "Открыть проект") {
          await this.context.globalState.update(ACTIVE_PROJECT_KEY, cwd);
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
    for (const controller of this.runs.values()) controller.abort();
    this.runs.clear();
  }

  private renderHtml(webview: vscode.Webview): string {
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
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
