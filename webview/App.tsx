import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentId,
  Attachment,
  HostToWebview,
  ProjectInfo,
  SettingsSnapshot,
  WebviewToHost,
} from "../src/shared/protocol";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };
const vscode = acquireVsCodeApi();

type ChatItem =
  | {
      id: number;
      role: "user" | "assistant";
      text: string;
      streaming?: boolean;
      attachments?: string[];
    }
  | { id: number; role: "tool"; toolName: string; summary: string }
  | { id: number; role: "info" | "error"; text: string }
  | {
      id: number;
      role: "meta";
      ok: boolean;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
    }
  | {
      id: number;
      role: "permission";
      requestId: string;
      toolName: string;
      inputPreview: string;
      status: "pending" | "allowed" | "denied";
      kind?: "tool" | "question";
      question?: string;
      options?: { label: string; description?: string }[];
      answerText?: string;
    };

let nextId = 1;

type ToolChipItem = Extract<ChatItem, { role: "tool" }>;

/** Подряд идущие вызовы инструментов схлопываются в одну раскрываемую группу. */
interface ToolGroup {
  role: "toolGroup";
  id: number;
  tools: ToolChipItem[];
}

/** Поле «свой ответ» в карточке вопроса агента. */
function QuestionCustomAnswer({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="q-custom">
      <input
        value={text}
        placeholder="Свой вариант ответа…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) onSubmit(text.trim());
        }}
      />
      <button disabled={!text.trim()} onClick={() => onSubmit(text.trim())}>
        Ответить
      </button>
    </div>
  );
}

/** 2 действия / 5 действий / 21 действие … */
function pluralActions(n: number): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return "действие";
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return "действия";
  return "действий";
}

export function App() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activePath, setActivePath] = useState<string>("");
  const [itemsByProject, setItemsByProject] = useState<Record<string, ChatItem[]>>({});
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [sessions, setSessions] = useState<Record<AgentId, string | null>>({
    claude: null,
    codex: null,
  });
  const [contextUsage, setContextUsage] = useState<
    Record<AgentId, { used: number; max: number } | null>
  >({ claude: null, codex: null });
  const [models, setModels] = useState<Record<AgentId, string>>({ claude: "", codex: "" });
  const [safety, setSafety] = useState<
    Record<AgentId, { label: string; dangerous: boolean } | null>
  >({ claude: null, codex: null });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [form, setForm] = useState<SettingsSnapshot | null>(null);
  const [newPassword, setNewPassword] = useState<string | undefined>(undefined);
  const [serverTest, setServerTest] = useState<{
    status: "idle" | "pending" | "ok" | "fail";
    message: string;
  }>({ status: "idle", message: "" });
  const [configJson, setConfigJson] = useState("");
  const [configResult, setConfigResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [agent, setAgent] = useState<AgentId>("claude");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  /** Сообщения, отправленные во время работы агента, — уходят после ответа. */
  const [queue, setQueue] = useState<{ text: string; attachments: Attachment[] }[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const agentRef = useRef(agent);
  agentRef.current = agent;

  const activeRef = useRef(activePath);
  activeRef.current = activePath;

  const items = itemsByProject[activePath] ?? [];
  const sessionId = sessions[agent];
  const activeProject = projects.find((p) => p.path === activePath);
  const [openGroups, setOpenGroups] = useState<Record<number, boolean>>({});

  /** Лента для рендера: подряд идущие tool-чипы собраны в группы. */
  const rendered = useMemo<(ChatItem | ToolGroup)[]>(() => {
    const out: (ChatItem | ToolGroup)[] = [];
    for (const it of items) {
      if (it.role === "tool") {
        const last = out[out.length - 1];
        if (last && last.role === "toolGroup") {
          last.tools.push(it);
        } else {
          out.push({ role: "toolGroup", id: it.id, tools: [it] });
        }
      } else {
        out.push(it);
      }
    }
    return out;
  }, [items]);

  const toggleGroup = (id: number) =>
    setOpenGroups((p) => ({ ...p, [id]: !p[id] }));

  /** Все мутации ленты идут в массив активного проекта. */
  const mutateItems = useCallback((updater: (prev: ChatItem[]) => ChatItem[]) => {
    setItemsByProject((prev) => {
      const path = activeRef.current;
      if (!path) return prev;
      return { ...prev, [path]: updater(prev[path] ?? []) };
    });
  }, []);

  const appendDelta = useCallback(
    (text: string) => {
      mutateItems((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          const updated = { ...last, text: last.text + text };
          return [...prev.slice(0, -1), updated];
        }
        return [...prev, { id: nextId++, role: "assistant", text, streaming: true }];
      });
    },
    [mutateItems],
  );

  const finalizeStreaming = useCallback(() => {
    mutateItems((prev) =>
      prev.map((it) =>
        it.role === "assistant" && it.streaming ? { ...it, streaming: false } : it,
      ),
    );
  }, [mutateItems]);

  /** Фактическая отправка: пузырь в ленту + сообщение хосту. */
  const dispatchSend = useCallback(
    (text: string, attachments: Attachment[]) => {
      mutateItems((p) => [
        ...p,
        {
          id: nextId++,
          role: "user",
          text,
          ...(attachments.length ? { attachments: attachments.map((a) => a.name) } : {}),
        },
      ]);
      vscode.postMessage({ type: "send", text, agent: agentRef.current, attachments });
    },
    [mutateItems],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent<HostToWebview>) => {
      const msg = e.data;
      switch (msg.type) {
        case "busy":
          setBusy(msg.value);
          if (!msg.value) {
            setActivity(null);
            finalizeStreaming();
            // Очередь «вдогонку»: следующий промпт уходит сам.
            const q = queueRef.current;
            if (q.length > 0) {
              const [next, ...rest] = q;
              setQueue(rest);
              setTimeout(() => dispatchSend(next.text, next.attachments), 60);
            }
          }
          break;
        case "activity":
          setActivity(msg.label);
          break;
        case "projects":
          setProjects(msg.projects);
          setActivePath(msg.activePath);
          break;
        case "transcript": {
          const restored = msg.items as ChatItem[];
          const maxId = restored.reduce((m, it) => Math.max(m, it?.id ?? 0), 0);
          if (maxId >= nextId) nextId = maxId + 1;
          setItemsByProject((prev) => ({ ...prev, [msg.path]: restored }));
          break;
        }
        case "sessionInfo":
          setSessions((prev) => ({ ...prev, [msg.agent]: msg.sessionId }));
          break;
        case "contextUsage":
          setContextUsage((prev) => ({
            ...prev,
            [msg.agent]: msg.max > 0 ? { used: msg.used, max: msg.max } : null,
          }));
          break;
        case "modelInfo":
          setModels((prev) => ({ ...prev, [msg.agent]: msg.model }));
          break;
        case "safetyInfo":
          setSafety((prev) => ({
            ...prev,
            [msg.agent]: { label: msg.label, dangerous: msg.dangerous },
          }));
          break;
        case "settings":
          setForm(msg.settings);
          setNewPassword(undefined);
          setServerTest({ status: "idle", message: "" });
          break;
        case "serverTestResult":
          setServerTest({ status: msg.ok ? "ok" : "fail", message: msg.message });
          break;
        case "configJson":
          setConfigJson(msg.json);
          break;
        case "configJsonResult":
          setConfigResult({ ok: msg.ok, message: msg.message });
          break;
        case "openSettingsScreen":
          setSettingsOpen(true);
          break;
        case "attachmentAdded":
          setPending((prev) => [
            ...prev,
            ...msg.files.filter((f) => !prev.some((p) => p.path === f.path)),
          ]);
          break;
        case "textDelta":
          appendDelta(msg.text);
          break;
        case "assistantText":
          finalizeStreaming();
          mutateItems((p) => [...p, { id: nextId++, role: "assistant", text: msg.text }]);
          break;
        case "toolUse":
          finalizeStreaming();
          mutateItems((p) => [
            ...p,
            { id: nextId++, role: "tool", toolName: msg.toolName, summary: msg.summary },
          ]);
          break;
        case "turnResult":
          finalizeStreaming();
          mutateItems((p) => [
            ...p,
            {
              id: nextId++,
              role: "meta",
              ok: msg.ok,
              costUsd: msg.costUsd,
              durationMs: msg.durationMs,
              numTurns: msg.numTurns,
            },
          ]);
          break;
        case "info":
          mutateItems((p) => [...p, { id: nextId++, role: "info", text: msg.text }]);
          break;
        case "error":
          finalizeStreaming();
          mutateItems((p) => [...p, { id: nextId++, role: "error", text: msg.message }]);
          break;
        case "reset":
          mutateItems(() => []);
          break;
        case "permissionRequest":
          finalizeStreaming();
          mutateItems((p) => [
            ...p,
            {
              id: nextId++,
              role: "permission",
              requestId: msg.requestId,
              toolName: msg.toolName,
              inputPreview: msg.inputPreview,
              status: "pending",
              kind: msg.kind,
              question: msg.question,
              options: msg.options,
            },
          ]);
          break;
        case "permissionResolved":
          mutateItems((p) =>
            p.map((it) =>
              it.role === "permission" && it.requestId === msg.requestId && it.status === "pending"
                ? { ...it, status: msg.allow ? "allowed" : "denied" }
                : it,
            ),
          );
          break;
      }
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, [appendDelta, finalizeStreaming, mutateItems, dispatchSend]);

  // Лента сохраняется на хосте (globalState) — переживает перезапуски VS Code.
  useEffect(() => {
    if (!activePath) return;
    vscode.postMessage({
      type: "saveTranscript",
      path: activePath,
      items: itemsByProject[activePath] ?? [],
    });
  }, [itemsByProject, activePath]);

  // Секундомер для строки активности.
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items, activity]);

  const answerPermission = (requestId: string, allow: boolean, answer?: string) => {
    mutateItems((p) =>
      p.map((it) =>
        it.role === "permission" && it.requestId === requestId && it.status === "pending"
          ? { ...it, status: allow ? "allowed" : "denied", ...(answer ? { answerText: answer } : {}) }
          : it,
      ),
    );
    vscode.postMessage({ type: "permission", requestId, allow, answer });
  };

  const send = () => {
    const text = draft.trim();
    if (!text && pending.length === 0) return;
    const finalText = text || "Посмотри приложенные файлы.";
    const attachments = pending;
    setDraft("");
    setPending([]);
    if (busy) {
      // Агент занят — в очередь; уйдёт автоматически после ответа.
      setQueue((q) => [...q, { text: finalText, attachments }]);
      return;
    }
    dispatchSend(finalText, attachments);
  };

  /** Вставка/перетаскивание файлов: байты уходят хосту, он сохраняет в проект. */
  const ingestFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) {
        mutateItems((p) => [
          ...p,
          { id: nextId++, role: "error", text: `«${file.name}» больше 20 МБ — прикрепите через 📎.` },
        ]);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        vscode.postMessage({
          type: "saveAttachment",
          name: file.name || "screenshot.png",
          dataBase64: base64,
        });
      };
      reader.readAsDataURL(file);
    }
  };

  const onProjectChange = (value: string) => {
    if (value === "__add__") {
      vscode.postMessage({ type: "addProject" });
      return;
    }
    setActivePath(value);
    vscode.postMessage({ type: "selectProject", path: value });
  };

  const formatElapsed = (s: number) =>
    s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;

  /** Иммутабельное обновление формы настроек. */
  const up = (fn: (f: SettingsSnapshot) => void) =>
    setForm((f) => {
      if (!f) return f;
      const copy = structuredClone(f);
      fn(copy);
      return copy;
    });

  const num = (v: string, fallback: number) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  if (settingsOpen) {
    return (
      <div className="app">
        <header className="topbar">
          <button className="finish-btn" onClick={() => setSettingsOpen(false)}>
            ← Назад
          </button>
          <span className="session">Настройки Agent Hub</span>
        </header>
        <main className="feed settings">
          {!form ? (
            <div className="empty">Загрузка…</div>
          ) : (
            <>
              {form.project && (
                <section>
                  <h3>📁 Проект «{form.project.name}»</h3>
                  <label className="set-row">
                    <span>Название</span>
                    <input
                      value={form.project.name}
                      onChange={(e) => up((f) => (f.project!.name = e.target.value))}
                    />
                  </label>
                  <label className="set-row">
                    <span>GitHub</span>
                    <input
                      value={form.project.githubRepo ?? ""}
                      placeholder="https://github.com/user/repo"
                      onChange={(e) => up((f) => (f.project!.githubRepo = e.target.value || undefined))}
                    />
                  </label>
                  <label className="set-row">
                    <span>Ветка git</span>
                    <input
                      value={form.project.branch ?? ""}
                      placeholder="main"
                      onChange={(e) => up((f) => (f.project!.branch = e.target.value || undefined))}
                    />
                  </label>
                  <label className="set-row">
                    <span>Сервер (хост)</span>
                    <input
                      value={form.project.serverHost ?? ""}
                      placeholder="1.2.3.4 или SSH-алиас"
                      onChange={(e) => up((f) => (f.project!.serverHost = e.target.value || undefined))}
                    />
                  </label>
                  <label className="set-row">
                    <span>Протокол</span>
                    <select
                      value={form.project.serverProtocol ?? "ssh"}
                      onChange={(e) =>
                        up((f) => {
                          const v = e.target.value as "ssh" | "sftp" | "ftp";
                          f.project!.serverProtocol = v === "ssh" ? undefined : v;
                        })
                      }
                    >
                      <option value="ssh">SSH — полный доступ к шеллу</option>
                      <option value="sftp">SFTP — файлы поверх SSH</option>
                      <option value="ftp">FTP — классический хостинг</option>
                    </select>
                  </label>
                  <label className="set-row">
                    <span>Порт</span>
                    <input
                      type="number"
                      value={form.project.serverPort ?? ""}
                      placeholder={form.project.serverProtocol === "ftp" ? "21" : "22"}
                      onChange={(e) =>
                        up((f) => {
                          const n = parseInt(e.target.value, 10);
                          f.project!.serverPort =
                            Number.isFinite(n) && n >= 1 && n <= 65535 ? n : undefined;
                        })
                      }
                    />
                  </label>
                  <label className="set-row">
                    <span>Логин</span>
                    <input
                      value={form.project.serverUser ?? ""}
                      placeholder="deploy"
                      onChange={(e) => up((f) => (f.project!.serverUser = e.target.value || undefined))}
                    />
                  </label>
                  <label className="set-row">
                    <span>Пароль сервера</span>
                    <input
                      type="password"
                      value={newPassword ?? ""}
                      placeholder={
                        newPassword === ""
                          ? "будет удалён"
                          : form.projectHasPassword
                            ? "задан · пусто — не менять"
                            : "не задан"
                      }
                      onChange={(e) => setNewPassword(e.target.value || undefined)}
                    />
                  </label>
                  {form.projectHasPassword && newPassword !== "" && (
                    <button className="finish-btn set-inline" onClick={() => setNewPassword("")}>
                      Удалить сохранённый пароль
                    </button>
                  )}
                  <label className="set-row">
                    <span>Заметки</span>
                    <input
                      value={form.project.server ?? ""}
                      placeholder="прод, логи, деплой…"
                      onChange={(e) => up((f) => (f.project!.server = e.target.value || undefined))}
                    />
                  </label>
                  <div className="set-actions" style={{ paddingBottom: 0 }}>
                    <button
                      className="finish-btn"
                      disabled={!form.project.serverHost || serverTest.status === "pending"}
                      title="Пробуем ssh по ключам, затем по сохранённому паролю (через sshpass)"
                      onClick={() => {
                        setServerTest({ status: "pending", message: "" });
                        vscode.postMessage({
                          type: "testServer",
                          host: form.project!.serverHost!,
                          user: form.project!.serverUser,
                          password: newPassword || undefined,
                          protocol: form.project!.serverProtocol ?? "ssh",
                          port: form.project!.serverPort,
                        });
                      }}
                    >
                      {serverTest.status === "pending" ? "⏳ Проверяю…" : "🔌 Проверить соединение"}
                    </button>
                  </div>
                  {serverTest.status === "ok" && (
                    <div className="test-ok">✓ {serverTest.message}</div>
                  )}
                  {serverTest.status === "fail" && (
                    <div className="danger-hint" style={{ paddingLeft: 0 }}>
                      ✗ {serverTest.message}
                    </div>
                  )}
                </section>
              )}

              <section>
                <h3>Claude</h3>
                <label className="set-row">
                  <span>Модель</span>
                  <input
                    value={form.claude.model}
                    placeholder="пусто — как в CLI (напр. claude-opus-5)"
                    onChange={(e) => up((f) => (f.claude.model = e.target.value))}
                  />
                </label>
                <label className="set-row">
                  <span>Effort</span>
                  <select
                    value={form.claude.effort}
                    onChange={(e) => up((f) => (f.claude.effort = e.target.value))}
                  >
                    {["", "low", "medium", "high", "xhigh", "max"].map((v) => (
                      <option key={v} value={v}>
                        {v || "по умолчанию"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="set-row">
                  <span>Разрешения</span>
                  <select
                    value={form.claude.permissionMode}
                    onChange={(e) => up((f) => (f.claude.permissionMode = e.target.value))}
                  >
                    <option value="default">с подтверждениями</option>
                    <option value="acceptEdits">правки без спроса</option>
                    <option value="bypassPermissions">⚠️ YOLO — без подтверждений</option>
                  </select>
                </label>
                {form.claude.permissionMode === "bypassPermissions" && (
                  <div className="danger-hint">
                    dangerously-skip-permissions: агент выполняет любые операции без вопросов.
                  </div>
                )}
                <label className="set-row">
                  <span>Лимит шагов</span>
                  <input
                    type="number"
                    value={form.claude.maxTurns}
                    title="0 — без лимита"
                    onChange={(e) => up((f) => (f.claude.maxTurns = num(e.target.value, 0)))}
                  />
                </label>
                <label className="set-row">
                  <span>Окно контекста</span>
                  <input
                    type="number"
                    value={form.claude.contextWindow}
                    onChange={(e) =>
                      up((f) => (f.claude.contextWindow = num(e.target.value, 200000)))
                    }
                  />
                </label>
              </section>

              <section>
                <h3>GPT (Codex)</h3>
                <label className="set-row">
                  <span>Модель</span>
                  <input
                    value={form.codex.model}
                    placeholder="пусто — из ~/.codex/config.toml"
                    onChange={(e) => up((f) => (f.codex.model = e.target.value))}
                  />
                </label>
                <label className="set-row">
                  <span>Effort</span>
                  <select
                    value={form.codex.effort}
                    onChange={(e) => up((f) => (f.codex.effort = e.target.value))}
                  >
                    {["", "minimal", "low", "medium", "high", "xhigh"].map((v) => (
                      <option key={v} value={v}>
                        {v || "по умолчанию"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="set-row">
                  <span>Песочница</span>
                  <select
                    value={form.codex.sandbox}
                    disabled={form.codex.yolo}
                    onChange={(e) => up((f) => (f.codex.sandbox = e.target.value))}
                  >
                    <option value="read-only">read-only — только чтение</option>
                    <option value="workspace-write">workspace-write — запись в проект</option>
                    <option value="danger-full-access">danger-full-access</option>
                  </select>
                </label>
                <label className="set-row set-check">
                  <input
                    type="checkbox"
                    checked={form.codex.yolo}
                    onChange={(e) => up((f) => (f.codex.yolo = e.target.checked))}
                  />
                  <span>⚠️ YOLO — без песочницы и подтверждений</span>
                </label>
                {form.codex.yolo && (
                  <div className="danger-hint">
                    --dangerously-bypass-approvals-and-sandbox: полный доступ к системе.
                  </div>
                )}
                <label className="set-row">
                  <span>Окно контекста</span>
                  <input
                    type="number"
                    value={form.codex.contextWindow}
                    onChange={(e) =>
                      up((f) => (f.codex.contextWindow = num(e.target.value, 400000)))
                    }
                  />
                </label>
              </section>

              <section>
                <h3>Разрешения без клика (Claude)</h3>
                <label className="set-col">
                  <span>Инструменты (по одному в строке)</span>
                  <textarea
                    rows={3}
                    value={form.autoAllowTools.join("\n")}
                    placeholder={"WebSearch\nWebFetch"}
                    onChange={(e) =>
                      up(
                        (f) =>
                          (f.autoAllowTools = e.target.value
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean)),
                      )
                    }
                  />
                </label>
                <label className="set-col">
                  <span>Префиксы bash-команд (по одному в строке)</span>
                  <textarea
                    rows={4}
                    value={form.autoAllowBash.join("\n")}
                    onChange={(e) =>
                      up(
                        (f) =>
                          (f.autoAllowBash = e.target.value
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean)),
                      )
                    }
                  />
                </label>
              </section>

              <section>
                <h3>Журнал сессий</h3>
                <label className="set-row">
                  <span>Папка</span>
                  <input
                    value={form.journalDir}
                    onChange={(e) => up((f) => (f.journalDir = e.target.value))}
                  />
                </label>
                <label className="set-row">
                  <span>Записей в контекст</span>
                  <input
                    type="number"
                    value={form.journalContextEntries}
                    onChange={(e) =>
                      up((f) => (f.journalContextEntries = num(e.target.value, 3)))
                    }
                  />
                </label>
              </section>

              <section>
                <h3>JSON-конфиг (продвинутое)</h3>
                <div className="set-hint">
                  Весь текущий конфиг: настройки агентов, allowlist, журнал и все
                  проекты. Правьте и нажмите «Применить» — проекты заменяются
                  списком из JSON целиком. Пароли сюда не входят.
                </div>
                <textarea
                  className="config-json"
                  rows={16}
                  spellCheck={false}
                  value={configJson}
                  onChange={(e) => {
                    setConfigJson(e.target.value);
                    setConfigResult(null);
                  }}
                />
                <div className="set-actions" style={{ paddingBottom: 0 }}>
                  <button
                    className="send set-save"
                    onClick={() => vscode.postMessage({ type: "applyConfigJson", json: configJson })}
                  >
                    Применить JSON
                  </button>
                  <button
                    className="finish-btn"
                    title="Вернуть текущее сохранённое состояние"
                    onClick={() => {
                      setConfigResult(null);
                      vscode.postMessage({ type: "getSettings" });
                    }}
                  >
                    Сбросить
                  </button>
                </div>
                {configResult && (
                  <div className={configResult.ok ? "test-ok" : "danger-hint"} style={{ paddingLeft: 0 }}>
                    {configResult.ok ? "✓ " : "✗ "}
                    {configResult.message}
                  </div>
                )}
              </section>

              <section>
                <h3>Перенос настроек</h3>
                <div className="set-actions" style={{ paddingBottom: 0 }}>
                  <button
                    className="finish-btn"
                    title="Все настройки и проекты — в JSON-файл (пароли не выгружаются)"
                    onClick={() => vscode.postMessage({ type: "exportSettings" })}
                  >
                    ⬇ Экспорт в JSON
                  </button>
                  <button
                    className="finish-btn"
                    title="Загрузить настройки из JSON: настройки перезапишутся, проекты добавятся/обновятся"
                    onClick={() => vscode.postMessage({ type: "importSettings" })}
                  >
                    ⬆ Импорт из JSON
                  </button>
                </div>
              </section>

              <div className="set-actions">
                <button
                  className="send set-save"
                  onClick={() => {
                    vscode.postMessage({ type: "saveSettings", settings: { ...form, newPassword } });
                    setSettingsOpen(false);
                  }}
                >
                  Сохранить
                </button>
                <button className="finish-btn" onClick={() => setSettingsOpen(false)}>
                  Отмена
                </button>
              </div>
            </>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <select
          className="project-select"
          value={activePath}
          onChange={(e) => onProjectChange(e.target.value)}
          disabled={busy}
          title={
            activeProject
              ? [
                  activeProject.path,
                  activeProject.githubRepo,
                  activeProject.branch && `ветка: ${activeProject.branch}`,
                  activeProject.serverHost &&
                    `сервер: ${(activeProject.serverProtocol ?? "ssh").toUpperCase()} ${activeProject.serverUser ? activeProject.serverUser + "@" : ""}${activeProject.serverHost}${activeProject.serverPort ? ":" + activeProject.serverPort : ""}`,
                ]
                  .filter(Boolean)
                  .join("\n")
              : ""
          }
        >
          {projects.length === 0 && <option value="">нет проектов</option>}
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              📁 {p.name}
            </option>
          ))}
          <option value="__add__">＋ Добавить проект…</option>
        </select>
        <select
          className="agent-select"
          value={agent}
          onChange={(e) => setAgent(e.target.value as AgentId)}
          disabled={busy}
        >
          <option value="claude">Claude</option>
          <option value="codex">GPT (Codex)</option>
        </select>
        <button
          className="finish-btn"
          title="История сессий проекта: вернуться к старой или удалить"
          disabled={busy}
          onClick={() => vscode.postMessage({ type: "showSessions" })}
        >
          🕘 История
        </button>
        <button
          className="finish-btn"
          title="Записать итоги сессии в журнал (docs/journal) и начать новую"
          disabled={busy || !sessionId}
          onClick={() => vscode.postMessage({ type: "finishSession", agent })}
        >
          ✍ Итоги
        </button>
        <button
          className="finish-btn"
          title="Настройки: проект, модели агентов, effort, YOLO, пароль сервера"
          onClick={() => {
            setSettingsOpen(true);
            vscode.postMessage({ type: "getSettings" });
          }}
        >
          ⚙
        </button>
        <span className="session" title={sessionId ?? ""}>
          {sessionId ? `сессия ${sessionId.slice(0, 8)}…` : "новая сессия"}
        </span>
      </header>
      <div className="statusbar">
        <span className="model-badge" title="Модель текущей сессии для выбранного агента">
          {models[agent] || "модель: по умолчанию CLI"}
        </span>
        <button
          className={`safety-btn ${safety[agent]?.dangerous ? "safety-danger" : ""}`}
          title="Режим разрешений выбранного агента — клик переключает (Claude: подтверждения → правки без спроса → YOLO; Codex: песочница ↔ YOLO)"
          onClick={() => vscode.postMessage({ type: "cycleSafety", agent })}
        >
          {safety[agent]?.label ?? "🔒"}
        </button>
        {contextUsage[agent] && (
          <span
            className="ctx"
            title={`Контекст: ~${contextUsage[agent]!.used.toLocaleString("ru-RU")} из ${contextUsage[agent]!.max.toLocaleString("ru-RU")} токенов`}
          >
            <span className="ctx-bar">
              <span
                className={`ctx-fill ${
                  contextUsage[agent]!.used / contextUsage[agent]!.max > 0.85
                    ? "ctx-danger"
                    : contextUsage[agent]!.used / contextUsage[agent]!.max > 0.6
                      ? "ctx-warn"
                      : ""
                }`}
                style={{
                  width: `${Math.min(100, Math.round((contextUsage[agent]!.used / contextUsage[agent]!.max) * 100))}%`,
                }}
              />
            </span>
            контекст {Math.min(100, Math.round((contextUsage[agent]!.used / contextUsage[agent]!.max) * 100))}%
          </span>
        )}
      </div>

      <main className="feed">
        {items.length === 0 && (
          <div className="empty">
            Спросите что-нибудь — агент работает в папке выбранного проекта: читает
            файлы, выполняет команды, коммитит. Проекты добавляются через «＋ Добавить
            проект…» (папка, GitHub-репозиторий, сервер).
          </div>
        )}
        {rendered.map((it) => {
          if (it.role === "toolGroup") {
            // Одиночное действие — та же строка-кнопка, клик раскрывает детали.
            if (it.tools.length === 1) {
              const t = it.tools[0];
              const isOpen = !!openGroups[t.id];
              return (
                <div key={`g-${it.id}`} className="tool-group">
                  <button
                    className="tool-group-header"
                    title={isOpen ? "Свернуть" : "Показать детали"}
                    onClick={() => toggleGroup(t.id)}
                  >
                    <span className="tool-group-arrow">{isOpen ? "▾" : "▸"}</span>
                    🔧 {t.toolName}
                    {t.summary && <span className="tool-group-names"> · {t.summary}</span>}
                  </button>
                  {isOpen && t.summary && <pre className="tool-detail">{t.summary}</pre>}
                </div>
              );
            }

            const isOpen = !!openGroups[it.id];
            const names = [...new Set(it.tools.map((t) => t.toolName))];
            return (
              <div key={`g-${it.id}`} className="tool-group">
                <button
                  className="tool-group-header"
                  title={isOpen ? "Свернуть" : "Развернуть список действий"}
                  onClick={() => toggleGroup(it.id)}
                >
                  <span className="tool-group-arrow">{isOpen ? "▾" : "▸"}</span>
                  🔧 {it.tools.length} {pluralActions(it.tools.length)}
                  <span className="tool-group-names">
                    {" · "}
                    {names.slice(0, 3).join(", ")}
                    {names.length > 3 ? "…" : ""}
                  </span>
                </button>
                {isOpen && (
                  <div className="tool-group-list">
                    {it.tools.map((t) => (
                      <div key={t.id} className="tool-line">
                        <span className="tool-line-name">🔧 {t.toolName}</span>
                        {t.summary && <pre className="tool-detail">{t.summary}</pre>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          switch (it.role) {
            case "user":
              return (
                <div key={it.id} className="msg user">
                  {it.text}
                  {it.attachments && it.attachments.length > 0 && (
                    <div className="msg-attachments">📎 {it.attachments.join(", ")}</div>
                  )}
                </div>
              );
            case "assistant":
              return (
                <div key={it.id} className="msg assistant md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.text}</ReactMarkdown>
                  {it.streaming && <span className="cursor">▌</span>}
                </div>
              );
            case "meta":
              return (
                <div key={it.id} className={`meta ${it.ok ? "" : "meta-error"}`}>
                  {it.ok ? "готово" : "завершено с ошибкой"}
                  {it.durationMs !== undefined && ` · ${(it.durationMs / 1000).toFixed(1)} с`}
                  {it.numTurns !== undefined && ` · шагов: ${it.numTurns}`}
                  {it.costUsd !== undefined && ` · $${it.costUsd.toFixed(4)}`}
                </div>
              );
            case "info":
              return (
                <div key={it.id} className="meta">
                  {it.text}
                </div>
              );
            case "error":
              return (
                <div key={it.id} className="msg error">
                  {it.text}
                </div>
              );
            case "permission": {
              if (it.kind === "question") {
                return (
                  <div key={it.id} className={`perm-card perm-${it.status}`}>
                    <div className="perm-title">❓ {it.question}</div>
                    {it.status === "pending" ? (
                      <div className="q-options">
                        {(it.options ?? []).map((o) => (
                          <button
                            key={o.label}
                            className="q-option"
                            onClick={() => answerPermission(it.requestId, false, o.label)}
                          >
                            {o.label}
                            {o.description && <span className="q-desc">{o.description}</span>}
                          </button>
                        ))}
                        <QuestionCustomAnswer
                          onSubmit={(t) => answerPermission(it.requestId, false, t)}
                        />
                      </div>
                    ) : (
                      <div className="perm-status">
                        {it.answerText ? `Ответ: ${it.answerText}` : "✗ без ответа"}
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <div key={it.id} className={`perm-card perm-${it.status}`}>
                  <div className="perm-title">
                    ⚠️ Агент хочет выполнить: <b>{it.toolName}</b>
                  </div>
                  <pre className="perm-input">{it.inputPreview}</pre>
                  {it.status === "pending" ? (
                    <div className="perm-actions">
                      <button
                        className="perm-allow"
                        onClick={() => answerPermission(it.requestId, true)}
                      >
                        ✓ Разрешить
                      </button>
                      <button
                        className="perm-deny"
                        onClick={() => answerPermission(it.requestId, false)}
                      >
                        ✗ Отклонить
                      </button>
                    </div>
                  ) : (
                    <div className="perm-status">
                      {it.status === "allowed" ? "✓ разрешено" : "✗ отклонено"}
                    </div>
                  )}
                </div>
              );
            }
          }
        })}
        {busy && (
          <div className="activity">
            <span className="spinner" />
            {activity ?? "Работает…"}
            {elapsed > 0 && <span className="activity-time"> · {formatElapsed(elapsed)}</span>}
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <footer
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) ingestFiles(e.dataTransfer.files);
        }}
      >
        {queue.length > 0 && (
          <div className="attach-row">
            {queue.map((q, i) => (
              <span key={i} className="attach-chip queue-chip" title={q.text}>
                ⏳ {q.text.slice(0, 60)}
                {q.text.length > 60 ? "…" : ""}
                <button
                  className="attach-remove"
                  title="Убрать из очереди"
                  onClick={() => setQueue((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        {pending.length > 0 && (
          <div className="attach-row">
            {pending.map((a) => (
              <span key={a.path} className="attach-chip" title={a.path}>
                📎 {a.name}
                <button
                  className="attach-remove"
                  title="Убрать вложение"
                  onClick={() => setPending((p) => p.filter((x) => x.path !== a.path))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          value={draft}
          placeholder="Сообщение агенту… (Enter — отправить, Cmd+V — вставить скриншот, файлы можно перетащить)"
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              ingestFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={3}
        />
        <div className="actions">
          <button
            className="attach-btn"
            title="Прикрепить файлы (или вставьте скриншот из буфера, или перетащите сюда)"
            disabled={busy}
            onClick={() => vscode.postMessage({ type: "pickAttachment" })}
          >
            📎
          </button>
          {busy ? (
            <>
              <button
                className="send"
                title="Сообщение отправится автоматически после ответа агента"
                onClick={send}
                disabled={!draft.trim() && pending.length === 0}
              >
                ⏳ В очередь
              </button>
              <button className="stop" onClick={() => vscode.postMessage({ type: "stop" })}>
                ⏹ Стоп
              </button>
            </>
          ) : (
            <button className="send" onClick={send} disabled={!draft.trim() && pending.length === 0}>
              Отправить
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
