import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-defaults-host-"));
const stubKey = Symbol.for("agent-hub-defaults-host-tests");
let current;
globalThis[stubKey] = { get current() { return current; } };
after(async () => { delete globalThis[stubKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-agent-defaults", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-defaults-host-tests")].current';
      if (path === "vscode") return { contents: `export const workspace={workspaceFolders:[],getConfiguration:(section)=>${h}.configuration(section)};export const window={createQuickPick:()=>${h}.quickPick,showQuickPick:async(items)=>{${h}.choices.push(items);return ${h}.pick;},showWarningMessage:async()=>${h}.warning,showInformationMessage:async()=>{},showErrorMessage:(message)=>${h}.errors.push(message)};export const Uri={},commands={executeCommand:async()=>{}},ViewColumn={},ConfigurationTarget={Global:1},ProgressLocation={},env={};export class ThemeIcon{};` };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected external process")};' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>"";export const buildFinishPrompt=()=>"";' };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{};export const enableTailscaleFunnel=()=>{};export const generateToken=()=>"";export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>"";export default {};' };
      return { contents: 'export class ClaudeBackend{};export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{};export const codexDefaultModel=()=>"codex-cli-default";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
const STORE = "agentHub.sessionStore", CHATS = "agentHub.multiChats";
const clone = value => structuredClone(value);
function memento(data) { return { keys: () => [...data.keys()], get: (key, fallback) => data.has(key) ? data.get(key) : fallback, update: async (key, value) => { data.set(key, value); } }; }
function setup({ settings = {}, global = new Map(), workspace = new Map(), saved = true } = {}) {
  const projects = ["one", "two"].map(name => ({ id: `project-${name}`, path: join(temp, name), name }));
  const record = { id: "record-one", title: "Новая сессия", createdAt: 1, updatedAt: 1, agentIds: { claude: null, codex: null }, items: [] };
  if (saved && !global.has(STORE)) global.set(STORE, { [projects[0].id]: { activeId: record.id, sessions: [record] } });
  const values = { "claude.model": "claude-base", "claude.effort": "high", "codex.model": "codex-base", "codex.effort": "xhigh", autoCommit: false, autoPull: false, projects, ...settings };
  const h = { global, workspace, values, projects, messages: [], errors: [], choices: [], pick: undefined };
  h.quickPick = { items: [], selectedItems: [], hide(){}, show(){}, dispose(){}, onDidTriggerItemButton(){}, onDidHide(){}, onDidAccept(fn){ h.acceptProject = fn; } };
  h.configuration = section => {
    const key = name => !section || section === "agentHub" ? name : `${section.replace(/^agentHub\./, "")}.${name}`;
    return { get: (name, fallback) => values[key(name)] ?? fallback, update: async (name, value) => { values[key(name)] = value; } };
  };
  current = h;
  const p = Object.create(ChatViewProvider.prototype);
  p.context = { globalState: memento(global), workspaceState: memento(workspace), secrets: { get: async()=>undefined, store: async()=>{}, delete: async()=>{} } };
  p.runs = new Map(); p.pendingPermissions = new Map(); p.deferred = new Map(); p.steers = new Map(); p.steerTexts = new Map();
  p.post = message => h.messages.push(message);
  p.multiPanel = { webview: { postMessage: message => h.messages.push(message) } };
  p.postSafety = () => {}; p.postSlashCommands = () => {}; p.postSettings = async () => {};
  p.listClaudeModels = () => [{ value: "claude-base", description: "Claude", supportedEffortLevels: ["low", "high"] }];
  p.listCodexModels = () => [{ slug: "codex-base", description: "Codex" }];
  p.codexEffortLevels = model => model === "codex-base" ? [{ effort: "low" }, { effort: "xhigh" }] : null;
  h.p = p;
  h.send = (message, surface = "multi-panel") => p.onMessage(message, "vscode", undefined, surface);
  h.active = () => p.getActiveRecord(projects[0].id);
  h.slotRecord = slot => p.getProjectStore(slot.projectPath).sessions.find(entry => entry.id === slot.recordId);
  return h;
}

test("a fixed common Codex provider selects Codex for a new tile without freezing base settings", async () => {
  const h = setup({ settings: { agentDefaults: { provider: "codex" } } });
  await h.send({ type: "createChat", projectPath: h.projects[0].id });
  const slot = h.p.getChatSlots().at(-1);
  assert.equal(slot.agent, "codex");
  assert.equal(h.p.buildAgentConfig("codex").model, "codex-base");
  assert.deepEqual(h.slotRecord(slot).modelOverrides ?? {}, {});
  assert.deepEqual(h.slotRecord(slot).effortOverrides ?? {}, {});
});

test("custom new-chat profiles seed model and effort into the actual runner configuration", async () => {
  const h = setup({ settings: { agentDefaults: { newChat: { mode: "custom", agent: "codex", model: "custom-codex", effort: "ultra" } } } });
  await h.send({ type: "createChat", projectPath: h.projects[0].id });
  const slot = h.p.getChatSlots().at(-1), record = h.slotRecord(slot);
  assert.equal(slot.agent, "codex");
  assert.deepEqual(record.modelOverrides, { codex: "custom-codex" });
  assert.deepEqual(record.effortOverrides, { codex: "ultra" });
  const config = h.p.buildAgentConfig(slot.agent, record.modelOverrides.codex, record.effortOverrides.codex);
  assert.equal(config.model, "custom-codex"); assert.equal(config.effort, "ultra");
  await h.send({ type: "ready", chatId: slot.chatId });
  assert.ok(h.messages.some(message => message.type === "effortInfo" && message.chatId === slot.chatId && message.effort === "ultra"));
});

test("a genuinely unbound ordinary startup receives its configured provider profile exactly once", async () => {
  const h = setup({ saved: false, settings: { agentDefaults: { startup: { mode: "custom", agent: "codex", model: "startup-model", effort: "high" } } } });
  await h.send({ type: "ready" }, "view");
  assert.ok(h.messages.some(message => message.type === "agentInfo" && message.agent === "codex"));
  const record = h.active(); assert.equal(record.preferredAgent, "codex"); assert.equal(record.modelOverrides.codex, "startup-model");
  const count = h.p.getProjectStore(h.projects[0].id).sessions.length;
  await h.send({ type: "ready" }, "panel");
  assert.equal(h.p.getProjectStore(h.projects[0].id).sessions.length, count);
});

test("saved empty sessions retain provider and overrides despite a different startup policy", async () => {
  const h = setup({ settings: { agentDefaults: { startup: { mode: "custom", agent: "claude", model: "new-default", effort: "low" } } } });
  Object.assign(h.active(), { preferredAgent: "codex", modelOverrides: { codex: "kept-model" }, effortOverrides: { codex: "ultra" } });
  await h.send({ type: "ready" }, "view");
  assert.equal(h.active().preferredAgent, "codex"); assert.equal(h.active().modelOverrides.codex, "kept-model");
  assert.ok(h.messages.some(message => message.type === "agentInfo" && message.agent === "codex"));
});

test("ordinary provider selection is persisted and restored after a new host starts", async () => {
  const h = setup();
  await h.send({ type: "selectAgent", agent: "codex", path: h.projects[0].id }, "view");
  assert.equal(h.active().preferredAgent, "codex");
  const restarted = setup({ global: h.global, workspace: h.workspace });
  await restarted.send({ type: "ready" }, "view");
  assert.ok(restarted.messages.some(message => message.type === "agentInfo" && message.agent === "codex"));
});

test("fixed defaults affect new tile sessions but preserve leaves current explicit choices intact", async () => {
  const h = setup({ settings: { agentDefaults: { provider: "codex" } } });
  const slot = { chatId: "chat-existing-one", projectPath: h.projects[0].id, recordId: h.active().id, agent: "claude" };
  await h.p.saveChatSlots([slot]);
  h.active().modelOverrides = { claude: "kept-claude" }; h.active().effortOverrides = { claude: "max" };
  await h.send({ type: "newSession", chatId: slot.chatId });
  assert.equal(h.p.findChatSlot(slot.chatId).agent, "codex");
  h.values.agentDefaults.newChat = { mode: "preserve" };
  const currentSlot = h.p.findChatSlot(slot.chatId), record = h.slotRecord(currentSlot);
  record.modelOverrides = { codex: "chosen-codex" }; record.effortOverrides = { codex: "ultra" };
  await h.send({ type: "newSession", chatId: slot.chatId });
  const next = h.slotRecord(h.p.findChatSlot(slot.chatId));
  assert.equal(next.modelOverrides.codex, "chosen-codex"); assert.equal(next.effortOverrides.codex, "ultra");
});

test("manual effort is scoped to its requesting record and displayed with the same identity", async () => {
  const h = setup(); const first = h.active();
  const second = { ...clone(first), id: "record-two" }; h.p.getProjectStore(h.projects[0].id).sessions.push(second);
  const slots = [first, second].map((record, i) => ({ chatId: `chat-effort-${i}`, projectPath: h.projects[0].id, recordId: record.id, agent: "codex" }));
  await h.p.saveChatSlots(slots);
  await h.p.applyEffort("codex", "low", slots[0].chatId);
  assert.equal(h.p.selectedEffort(first, "codex"), "low");
  assert.equal(first.effortOverrides.codex, "low"); assert.equal(second.effortOverrides?.codex, undefined);
  assert.equal(h.values["codex.effort"], "xhigh");
  assert.ok(h.messages.some(message => message.type === "effortInfo" && message.agent === "codex" && message.chatId === slots[0].chatId && message.recordId === first.id && message.effort === "low"));
  assert.equal(h.messages.some(message => message.type === "effortInfo" && message.agent === "codex" && message.chatId === slots[1].chatId && message.effort === "low"), false);
});

test("ordinary effort selection persists in the active record rather than changing common defaults", async () => {
  const h = setup(); h.active().modelOverrides = { claude: "custom-claude" }; await h.p.applyEffort("claude", "max");
  assert.equal(h.active().effortOverrides.claude, "max"); assert.equal(h.values["claude.effort"], "high");
});

test("settings snapshots expose provider-dependent catalogs and defaults, while old imports preserve rules", async () => {
  const h = setup({ settings: { agentDefaults: { provider: "codex" } } });
  const settings = await h.p.buildSettingsSnapshot();
  assert.equal(settings.agentDefaults.provider, "codex");
  assert.deepEqual(settings.agentCatalog.claude[0].efforts, ["low", "high"]);
  assert.deepEqual(settings.agentCatalog.codex[0].efforts, ["low", "xhigh"]);
  const before = clone(h.values.agentDefaults);
  await h.p.applySettingsFields({ claude: { model: "new-common-model" } });
  assert.deepEqual(h.values.agentDefaults, before);
  assert.equal(h.p.collectAllSettings().agentDefaults.provider, "codex");
});

test("new-project rules seed only the newly created project's ordinary session", async () => {
  const h = setup({ settings: { agentDefaults: { newProject: { mode: "custom", agent: "codex", model: "project-model", effort: "ultra" } } } });
  const previous = clone(h.active());
  const folder = join(temp, "new-project"); await mkdir(folder, { recursive: true });
  await h.p.addPickedProject(folder);
  const added = h.values.projects.at(-1), record = h.p.getActiveRecord(added.id);
  assert.equal(record.preferredAgent, "codex"); assert.equal(record.modelOverrides.codex, "project-model"); assert.equal(record.effortOverrides.codex, "ultra");
  assert.deepEqual(h.p.getActiveRecord(h.projects[0].id), previous);
});

test("saved board bindings take precedence over current defaults across rehydration", async () => {
  const h = setup({ settings: { agentDefaults: { provider: "codex", startup: { mode: "custom", agent: "codex", model: "startup", effort: "ultra" } } } });
  const record = h.active(); Object.assign(record, { preferredAgent: "claude", modelOverrides: { claude: "saved-claude" }, effortOverrides: { claude: "max" } });
  const slots = [{ chatId: "chat-saved-profile", projectPath: h.projects[0].id, recordId: record.id, agent: "claude" }];
  await h.p.saveChatSlots(slots); const before = clone(slots);
  await h.send({ type: "multiStateReady", chatIds: [] });
  assert.deepEqual(h.p.getChatSlots(), before);
  assert.equal(record.modelOverrides.claude, "saved-claude"); assert.equal(record.effortOverrides.claude, "max");
});

test("the backend start receives the record's model and effort rather than common values", async () => {
  const h = setup(); await mkdir(h.projects[0].path, { recursive: true });
  Object.assign(h.active(), { preferredAgent: "codex", modelOverrides: { codex: "runner-model" }, effortOverrides: { codex: "ultra" } });
  h.p.sessionWriters = new Map();
  h.p.relocateAttachments = async (_cwd, attachments) => attachments;
  h.p.autoPull = async () => {}; h.p.buildProjectCard = async () => "";
  let received;
  h.p.backends = { codex: { async *start(_prompt, options) { received = options; } } };
  await h.p.runTurn("test prompt", "codex", [], h.projects[0].id);
  assert.ok(received, JSON.stringify(h.messages.filter(message => message.type === "error")));
  assert.equal(received.config.model, "runner-model"); assert.equal(received.config.effort, "ultra");
});

test("busy ordinary provider selection acknowledges the unchanged provider and malformed providers do nothing", async () => {
  const h = setup(); h.active().preferredAgent = "claude"; h.p.runs.set(h.projects[0].id, new AbortController());
  await h.send({ type: "selectAgent", agent: "codex", path: h.projects[0].id }, "view");
  const ack = h.messages.filter(message => message.type === "agentInfo").at(-1);
  assert.equal(ack.agent, "claude"); assert.equal(ack.requestedAgent, "codex"); assert.ok(ack.error);
  await h.send({ type: "selectAgent", agent: "other", path: h.projects[0].id }, "view");
  assert.equal(h.active().preferredAgent, "claude");
});

test("failed provider record persistence rolls back the choice and acknowledges the actual provider", async () => {
  const h = setup(); h.active().preferredAgent = "claude";
  const update = h.p.context.globalState.update;
  h.p.context.globalState.update = async (key, value) => { if (key === STORE) throw new Error("record persistence failed"); await update(key, value); };
  await h.send({ type: "selectAgent", agent: "codex", path: h.projects[0].id }, "view");
  const ack = h.messages.filter(message => message.type === "agentInfo").at(-1);
  assert.equal(ack.agent, "claude"); assert.equal(ack.requestedAgent, "codex"); assert.ok(ack.error);
  assert.equal(h.active().preferredAgent, "claude");
});

test("an old ordinary effort picker cannot alter a replacement session in the same project", async () => {
  const h = setup(); let release;
  h.pick = new Promise(resolve => { release = resolve; });
  const picking = h.p.pickEffort("codex");
  await h.p.newSession();
  release({ value: "high" }); await picking;
  assert.equal(h.active().effortOverrides?.codex, undefined);
});

test("new settings import is normalized and old imports leave its conditional rules intact", async () => {
  const h = setup(); await h.p.applySettingsFields({ agentDefaults: { provider: "codex", newChat: { mode: "custom", agent: "claude", model: "chosen-model", effort: "ultra" } } });
  assert.equal(h.values.agentDefaults.provider, "codex"); assert.equal(h.values.agentDefaults.newChat.effort, "");
  const before = clone(h.values.agentDefaults); await h.p.applySettingsFields({ autoPull: false });
  assert.deepEqual(h.values.agentDefaults, before);
});

test("custom effort follows inherited model capabilities and the badge matches the backend", async () => {
  const h = setup({ settings: { agentDefaults: { newChat: { mode: "custom", agent: "codex", model: "", effort: "ultra" } } } });
  await h.send({ type: "createChat", projectPath: h.projects[0].id });
  const slot = h.p.getChatSlots().at(-1), record = h.slotRecord(slot);
  const config = h.p.buildAgentConfig("codex", record.modelOverrides?.codex, record.effortOverrides?.codex);
  assert.equal(config.effort, "xhigh");
  await h.send({ type: "ready", chatId: slot.chatId });
  const badge = h.messages.filter(message => message.type === "effortInfo" && message.chatId === slot.chatId && message.agent === "codex").at(-1);
  assert.equal(badge.effort, config.effort);
  assert.equal(h.p.collectAllSettings().agentDefaults.newChat.effort, "");
});

test("changing to a model that cannot use an old effort never forwards the unsupported value", async () => {
  const h = setup();
  Object.assign(h.active(), { modelOverrides: { codex: "codex-base" }, effortOverrides: { codex: "ultra" } });
  assert.equal(h.p.buildAgentConfig("codex", "codex-base", "ultra").effort, "xhigh");
  assert.equal(h.p.selectedEffort(h.active(), "codex"), "xhigh");
  h.values["codex.effort"] = "ultra";
  assert.equal(h.p.buildAgentConfig("codex", "codex-base", "ultra").effort, undefined);
  assert.equal(h.p.selectedEffort(h.active(), "codex"), "");
});

test("manual unsupported effort cannot persist a value not offered by the selected model", async () => {
  const h = setup(); await h.p.applyEffort("codex", "ultra");
  assert.equal(h.active().effortOverrides?.codex, undefined);
  assert.ok(h.messages.some(message => message.type === "info" && /effort/i.test(message.text)));
});

test("new-session context acknowledgements identify the final binding on success and failure", async () => {
  const h = setup({ settings: { agentDefaults: { provider: "codex" } } });
  const slot = { chatId: "chat-context-token", projectPath: h.projects[0].id, recordId: h.active().id, agent: "claude" };
  await h.p.saveChatSlots([slot]);
  await h.send({ type: "newSession", chatId: slot.chatId, requestId: "context-success" });
  const next = h.p.findChatSlot(slot.chatId);
  let ack = h.messages.filter(message => message.type === "agentInfo" && message.contextRequestId === "context-success").at(-1);
  assert.equal(ack.recordId, next.recordId); assert.equal(ack.agent, "codex");
  h.p.runs.set(slot.chatId, new AbortController());
  await h.send({ type: "newSession", chatId: slot.chatId, requestId: "context-busy" });
  ack = h.messages.filter(message => message.type === "agentInfo" && message.contextRequestId === "context-busy").at(-1);
  assert.equal(ack.recordId, next.recordId); assert.ok(ack.error);
});

test("ordinary new-session persistence failure keeps the existing record and releases its request", async () => {
  const h = setup({ settings: { agentDefaults: { provider: "codex" } } });
  const previous = clone(h.active());
  h.p.context.globalState.update = async () => { throw new Error("storage unavailable"); };
  await h.send({ type: "newSession", requestId: "context-failed-save" }, "view");
  const ack = h.messages.filter(message => message.type === "agentInfo" && message.contextRequestId === "context-failed-save").at(-1);
  assert.equal(ack.recordId, previous.id); assert.ok(ack.error);
  assert.deepEqual(h.active(), previous);
});

test("a new-session request without an available project still acknowledges the ordinary view", async () => {
  const h = setup({ settings: { projects: [], agentDefaults: { provider: "codex" } } });
  h.p.multiPanel = null;
  await h.send({ type: "newSession", requestId: "context-no-project" }, "view");
  const ack = h.messages.filter(message => message.type === "agentInfo" && message.contextRequestId === "context-no-project").at(-1);
  assert.equal(ack?.agent, "codex"); assert.ok(ack);
});

test("both project copy actions apply new-project rules without copying conversation history", async () => {
  for (const copyFolder of [false, true]) {
    const h = setup({ settings: { agentDefaults: { provider: "claude", startup: { mode: "custom", agent: "claude", model: "startup-model", effort: "low" }, newProject: { mode: "custom", agent: "codex", model: "copy-project-model", effort: "ultra" } } } });
    await mkdir(h.projects[0].path, { recursive: true });
    h.warning = "Создать копию";
    const source = h.active(); source.items = [{ role: "user", text: "source history stays in source" }];
    source.preferredAgent = "claude";
    await h.p.duplicateProject(h.projects[0].id, copyFolder);
    const created = h.values.projects.at(-1);
    assert.notEqual(created.id, h.projects[0].id, JSON.stringify(h.errors));
    const record = h.p.getActiveRecord(created.id);
    assert.equal(record?.preferredAgent, "codex");
    assert.deepEqual(record.modelOverrides, { codex: "copy-project-model" });
    assert.deepEqual(record.effortOverrides, { codex: "ultra" });
    assert.deepEqual(record.items, []);
    assert.deepEqual(source.items, [{ role: "user", text: "source history stays in source" }]);
  }
});

test("changing a session model immediately refreshes the effective effort badge", async () => {
  const h = setup(); Object.assign(h.active(), { modelOverrides: { codex: "custom-model" }, effortOverrides: { codex: "ultra" } });
  const slot = { chatId: "chat-model-effort", projectPath: h.projects[0].id, recordId: h.active().id, agent: "codex" };
  await h.p.saveChatSlots([slot]);
  await h.p.applyModel("codex", "codex-base", false, slot.chatId);
  const badge = h.messages.filter(message => message.type === "effortInfo" && message.chatId === slot.chatId && message.agent === "codex").at(-1);
  assert.equal(badge?.effort, "xhigh");
  assert.equal(h.messages.some(message => message.type === "transcript"), false);
});

test("dropdown and native selection bind an unbound project before publishing its startup profile", async () => {
  for (const native of [false, true]) {
    const h = setup({ settings: { agentDefaults: { startup: { mode: "custom", agent: "codex", model: "startup-selection-model", effort: "high" } } } });
    if (native) {
      await h.p.manageProjects(); h.quickPick.selectedItems = [{ path: h.projects[1].id }]; await h.acceptProject();
    } else await h.send({ type: "selectProject", path: h.projects[1].id }, "view");
    const record = h.p.getActiveRecord(h.projects[1].id);
    assert.equal(record?.modelOverrides.codex, "startup-selection-model");
    const model = h.messages.filter(message => message.type === "modelInfo" && !message.chatId && message.path === h.projects[1].id && message.agent === "codex").at(-1);
    const effort = h.messages.filter(message => message.type === "effortInfo" && !message.chatId && message.path === h.projects[1].id && message.agent === "codex").at(-1);
    assert.equal(model?.model, "startup-selection-model"); assert.equal(effort?.effort, "high");
  }
});

test("a remembered-profile write failure after new-session commit still hydrates the committed context", async () => {
  const h = setup({ settings: { agentDefaults: { provider: "codex" } } });
  h.active().items = [{ id: 1, role: "user", text: "old transcript" }];
  const oldId = h.active().id, update = h.p.context.workspaceState.update;
  h.p.context.workspaceState.update = async (key, value) => { if (key === "agentHub.lastAgentChoice") throw new Error("last-choice write failed"); await update(key, value); };
  await h.send({ type: "newSession", requestId: "context-after-commit" }, "view");
  assert.notEqual(h.active().id, oldId);
  assert.ok(h.messages.some(message => message.type === "transcript" && !message.chatId && message.path === h.projects[0].id && message.items.length === 0));
  const ack = h.messages.filter(message => message.type === "agentInfo" && message.contextRequestId === "context-after-commit").at(-1);
  assert.equal(ack.recordId, h.active().id); assert.equal(ack.agent, "codex");
});

test("the latest newly created startup profile becomes the source for last-used new chats", async () => {
  const h = setup({ saved: false, settings: { agentDefaults: { startup: { mode: "custom", agent: "codex", model: "startup-visible-profile", effort: "high" } } } });
  await h.send({ type: "ready" }, "view");
  await h.send({ type: "createChat", projectPath: h.projects[0].id });
  const slot = h.p.getChatSlots().at(-1);
  assert.equal(slot.agent, "codex"); assert.equal(h.slotRecord(slot).modelOverrides.codex, "startup-visible-profile");
});

test("effort picker origin is rechecked inside the mutation queue after a queued new session", async () => {
  const h = setup(); const slot = { chatId: "chat-effort-origin", projectPath: h.projects[0].id, recordId: h.active().id, agent: "codex" };
  await h.p.saveChatSlots([slot]); let resolvePick;
  h.pick = new Promise(resolve => { resolvePick = resolve; });
  const picking = h.p.pickEffort("codex", undefined, slot.chatId);
  let releaseQueue; const blocking = h.p.serializeMultiMutation(() => new Promise(resolve => { releaseQueue = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const replacing = h.p.newSession(slot.chatId);
  resolvePick({ value: "low" }); await new Promise(resolve => setImmediate(resolve));
  releaseQueue(); await blocking; await replacing; await picking;
  assert.equal(h.slotRecord(h.p.findChatSlot(slot.chatId)).effortOverrides?.codex, undefined);
});

test("model picker origin cannot overwrite or clear a replacement record's custom profile", async () => {
  for (const base of [false, true]) {
    const h = setup({ settings: { agentDefaults: { newChat: { mode: "custom", agent: "codex", model: "policy-model", effort: "ultra" } } } });
    const slot = { chatId: "chat-model-origin", projectPath: h.projects[0].id, recordId: h.active().id, agent: "codex" };
    await h.p.saveChatSlots([slot]); let resolvePick;
    h.pick = new Promise(resolve => { resolvePick = resolve; });
    const picking = h.p.pickModel("codex", undefined, slot.chatId);
    let releaseQueue; const blocking = h.p.serializeMultiMutation(() => new Promise(resolve => { releaseQueue = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    const replacing = h.p.newSession(slot.chatId);
    resolvePick({ value: "old-modal-model" }); h.pick = { base };
    await new Promise(resolve => setImmediate(resolve)); releaseQueue(); await blocking; await replacing; await picking;
    assert.equal(h.slotRecord(h.p.findChatSlot(slot.chatId)).modelOverrides.codex, "policy-model");
    if (base) assert.equal(h.values["codex.model"], "old-modal-model");
  }
});

test("a known model without effort capabilities uses only CLI defaults", async () => {
  const h = setup({ settings: { agentDefaults: { newChat: { mode: "custom", agent: "claude", model: "claude-base", effort: "max" } } } });
  h.p.listClaudeModels = () => [{ value: "claude-base", supportedEffortLevels: [] }];
  assert.equal(h.p.buildAgentConfig("claude", "claude-base", "max").effort, undefined);
  assert.deepEqual((await h.p.buildSettingsSnapshot()).agentCatalog.claude[0].efforts, []);
  await h.p.applyEffort("claude", "max"); assert.equal(h.active().effortOverrides?.claude, undefined);
  assert.equal(h.p.collectAllSettings().agentDefaults.newChat.effort, "");
});

test("malformed persisted Claude catalog entries cannot break settings or backend configuration", async () => {
  for (const catalog of [[null], [{ value: "claude-base", supportedEffortLevels: "high" }], { length: 1 }]) {
    const h = setup(); delete h.p.listClaudeModels;
    h.global.set("agentHub.claudeModels", catalog);
    assert.doesNotThrow(() => h.p.buildAgentConfig("claude"));
    const settings = await h.p.buildSettingsSnapshot();
    assert.ok(Array.isArray(settings.agentCatalog.claude));
    assert.ok(settings.agentCatalog.claude.every(model => typeof model.value === "string" && Array.isArray(model.efforts)));
  }
});

test("imports bind only the visible unbound project before publishing its startup profile", async () => {
  for (const configJson of [false, true]) {
    const h = setup({ saved: false, settings: { projects: [], agentDefaults: { startup: { mode: "custom", agent: "codex", model: "imported-startup-model", effort: "high" } } } });
    const imported = { projects: h.projects };
    if (configJson) await h.p.applyConfigJson(JSON.stringify(imported)); else await h.p.applyImportedSettings(imported);
    const record = h.p.getActiveRecord(h.projects[0].id);
    assert.equal(record?.preferredAgent, "codex");
    assert.equal(record?.modelOverrides.codex, "imported-startup-model");
    assert.equal(h.p.getActiveRecord(h.projects[1].id), null);
    const model = h.messages.filter(message => message.type === "modelInfo" && !message.chatId && message.agent === "codex").at(-1);
    const effort = h.messages.filter(message => message.type === "effortInfo" && !message.chatId && message.agent === "codex").at(-1);
    assert.equal(model.model, "imported-startup-model"); assert.equal(effort.effort, "high");
    assert.equal(h.p.buildAgentConfig("codex", record.modelOverrides.codex, record.effortOverrides.codex).model, model.model);
  }
});

test("a last-choice failure cannot hide a newly committed project or copy", async () => {
  for (const action of ["add", "copy", "copy-folder"]) {
    const h = setup({ settings: { agentDefaults: { provider: "codex" } } });
    const update = h.p.context.workspaceState.update;
    h.p.context.workspaceState.update = async (key, value) => { if (key === "agentHub.lastAgentChoice") throw new Error("last-choice write failed"); await update(key, value); };
    if (action === "add") {
      const folder = join(temp, "last-choice-add"); await mkdir(folder, { recursive: true }); await h.p.addPickedProject(folder);
    } else {
      await mkdir(h.projects[0].path, { recursive: true }); h.warning = "Создать копию";
      await h.p.duplicateProject(h.projects[0].id, action === "copy-folder");
    }
    const created = h.values.projects.at(-1);
    assert.equal(h.p.getActiveRecord(created.id)?.preferredAgent, "codex");
    assert.ok(h.messages.some(message => message.type === "projects" && message.activePath === created.id && message.projects.some(project => project.id === created.id)));
    assert.equal(h.errors.some(message => /Не удалось создать|Не удалось добавить/.test(message)), false);
  }
});

test("Codex cache normalization preserves explicit no-effort capabilities and rejects malformed entries", async () => {
  const h = setup(); delete h.p.listCodexModels; delete h.p.codexEffortLevels;
  h.p.cachedCodexModels = () => [null, { slug: "codex-base", supported_reasoning_levels: [] }, { slug: "codex-base", supported_reasoning_levels: [{ effort: "ultra" }] }, { slug: " " }, { slug: "other", description: 42, supported_reasoning_levels: "high" }];
  const settings = await h.p.buildSettingsSnapshot();
  assert.deepEqual(settings.agentCatalog.codex.map(model => model.value), ["codex-base", "other"]);
  assert.deepEqual(settings.agentCatalog.codex[0].efforts, []);
  assert.equal(h.p.buildAgentConfig("codex", "codex-base", "ultra").effort, undefined);
  assert.equal(h.p.codexEffortLevels("other"), null);
});
