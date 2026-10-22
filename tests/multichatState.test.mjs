import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-multichat-state-"));
const stubKey = Symbol.for("agent-hub-multichat-state-tests");
let current;
globalThis[stubKey] = { get current() { return current; } };
after(async () => { delete globalThis[stubKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-multichat-provider", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-multichat-state-tests")].current';
      if (path === "vscode") return { contents: `export const workspace={getConfiguration:()=>({get:(_key,fallback)=>fallback,update:async()=>{}})}; export const window={createQuickPick:()=>${h}.quickPick,showWarningMessage:async()=>"Удалить"};export const Uri={},commands={},ViewColumn={},ConfigurationTarget={},ProgressLocation={},env={}; export class ThemeIcon{};` };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected external process")};' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>""; export const buildFinishPrompt=()=>"";' };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{}; export const enableTailscaleFunnel=()=>{}; export const generateToken=()=>""; export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>""; export default {};' };
      return { contents: 'export class ClaudeBackend{}; export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{}; export const codexDefaultModel=()=>"test";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
const STORE = "agentHub.sessionStore";
const CHATS = "agentHub.multiChats";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function gate() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function record(id, { user = false, updatedAt = 1 } = {}) {
  return { id, title: "Новая сессия", createdAt: 1, updatedAt, agentIds: { claude: null, codex: null }, items: user ? [{ role: "user", text: id }] : [] };
}
function setup() {
  const projects = ["one", "two", "three"].map((name) => ({ id: `project-${name}`, path: join(temp, name), name }));
  const records = Array.from({ length: 4 }, (_, i) => record(`record-${i}`));
  const slots = records.map((rec, i) => ({ chatId: `chat-fixture-${i}`, projectPath: projects[0].id, recordId: rec.id, agent: "claude" }));
  const data = new Map([[CHATS, slots], [STORE, { [projects[0].id]: { activeId: null, sessions: records } }]]);
  const h = { data, projects, records, slots, messages: [], writes: [], beforeUpdate: undefined, quickPick: {} };
  h.quickPick = { items: [], selectedItems: [], show() {}, hide() {}, dispose() {}, onDidTriggerItemButton(fn) { h.deleteItem = fn; }, onDidAccept(fn) { h.acceptItem = fn; }, onDidHide() {} };
  current = h;
  const p = Object.create(ChatViewProvider.prototype);
  p.context = { globalState: {
    get: (key, fallback) => data.has(key) ? data.get(key) : fallback,
    update: async (key, value) => { await h.beforeUpdate?.(key, value); h.writes.push(key); data.set(key, value); },
  } };
  p.getAllProjects = () => projects; p.getProjects = () => projects; p.getActiveProject = () => projects[0];
  p.runs = new Map(); p.pendingPermissions = new Map(); p.deferred = new Map(); p.steers = new Map(); p.steerTexts = new Map();
  p.multiPanel = { webview: { postMessage: (message) => h.messages.push(message) } };
  p.post = (message) => h.messages.push(message);
  p.postSafety = () => {}; p.postEfforts = () => {}; p.postSlashCommands = () => {};
  h.p = p;
  h.send = (message) => p.onMessage(message, "vscode", undefined, "multi-panel");
  return h;
}

test("persisting a tile transcript never replays hydration to any chat", async () => {
  const h = setup();
  await h.send({ type: "saveTranscript", chatId: h.slots[0].chatId, path: h.projects[0].id, recordId: h.records[0].id, items: [{ role: "user", text: "A new title" }] });
  assert.deepEqual(h.p.getProjectStore(h.projects[0].id).sessions[0].items, [{ role: "user", text: "A new title" }]);
  assert.equal(h.messages.some((message) => message.type === "transcript" || message.type === "projects"), false);
  assert.equal(h.messages.find((message) => message.type === "multiState")?.chats[0].title, "A new title");
  h.messages.length = 0;
  await h.send({ type: "saveTranscript", chatId: h.slots[0].chatId, path: h.projects[0].id, recordId: h.records[0].id, items: [{ role: "user", text: "A new title" }, { role: "assistant", text: "Done" }] });
  assert.deepEqual(h.messages, [], "routine persistence must not trigger another state response");
});

test("a delayed save for the replaced tile record cannot overwrite its new transcript", async () => {
  const h = setup(); const slot = h.slots[0];
  await h.send({ type: "selectChatProject", chatId: slot.chatId, projectPath: h.projects[1].id });
  h.messages.length = 0;
  await h.send({ type: "saveTranscript", chatId: slot.chatId, path: h.projects[1].id, recordId: slot.recordId, items: [{ role: "user", text: "stale" }] });
  const selected = h.p.findChatSlot(slot.chatId);
  assert.deepEqual(h.p.getProjectStore(selected.projectPath).sessions.find((rec) => rec.id === selected.recordId).items, []);
  assert.deepEqual(h.messages, []);
});

test("legacy New Session preserves all four blank tile records", async () => {
  const h = setup();
  await h.p.newSession();
  const live = h.p.getChatSlots();
  assert.deepEqual(live.map((slot) => slot.chatId), h.slots.map((slot) => slot.chatId));
  assert.ok(live.every((slot) => h.p.getProjectStore(slot.projectPath).sessions.some((rec) => rec.id === slot.recordId)));
});

test("the legacy history limit retains old records still displayed by a tile", async () => {
  const h = setup(); const store = h.p.getProjectStore(h.projects[0].id);
  h.records.forEach((rec) => { rec.items = [{ role: "user", text: rec.id }]; });
  store.sessions.push(...Array.from({ length: 35 }, (_, i) => record(`history-${i}`, { user: true, updatedAt: i + 10 })));
  store.activeId = "history-34";
  await h.p.newSession();
  assert.deepEqual(h.p.getChatSlots().map((slot) => slot.chatId), h.slots.map((slot) => slot.chatId));
  assert.ok(h.p.getProjectStore(h.projects[0].id).sessions.length <= 34, "only displayed records may exceed the normal history limit");
});

test("deleting a history entry rebinds every tile using it without closing tiles", async () => {
  const h = setup(); h.records[0].items = [{ role: "user", text: "shared record" }];
  h.slots[1].recordId = h.records[0].id;
  await h.p.showSessions();
  await h.deleteItem({ item: { sessionId: h.records[0].id } });
  const live = h.p.getChatSlots();
  assert.equal(live.length, 4);
  assert.ok(live.every((slot) => slot.recordId !== h.records[0].id));
  assert.ok(live.every((slot) => h.p.getProjectStore(slot.projectPath).sessions.some((rec) => rec.id === slot.recordId)));
});

test("overlapping selections in different tiles preserve both requested projects", async () => {
  const h = setup(); const saving = gate(); const release = gate(); let paused = false;
  h.beforeUpdate = async (key) => { if (key === CHATS && !paused) { paused = true; saving.resolve(); await release.promise; } };
  const first = h.send({ type: "selectChatProject", chatId: h.slots[0].chatId, projectPath: h.projects[1].id });
  await saving.promise;
  const second = h.send({ type: "selectChatProject", chatId: h.slots[1].chatId, projectPath: h.projects[2].id });
  await tick(); release.resolve(); await Promise.all([first, second]);
  const live = h.p.getChatSlots();
  assert.equal(live.length, 4);
  assert.equal(live.find((slot) => slot.chatId === h.slots[0].chatId).projectPath, h.projects[1].id);
  assert.equal(live.find((slot) => slot.chatId === h.slots[1].chatId).projectPath, h.projects[2].id);
});

test("rapid project selections for one tile settle on the last requested project", async () => {
  const h = setup(); const saving = gate(); const release = gate(); let paused = false;
  h.beforeUpdate = async (key) => { if (key === CHATS && !paused) { paused = true; saving.resolve(); await release.promise; } };
  const first = h.send({ type: "selectChatProject", chatId: h.slots[0].chatId, projectPath: h.projects[1].id });
  await saving.promise;
  const second = h.send({ type: "selectChatProject", chatId: h.slots[0].chatId, projectPath: h.projects[2].id });
  await tick(); release.resolve(); await Promise.all([first, second]);
  assert.equal(h.p.findChatSlot(h.slots[0].chatId).projectPath, h.projects[2].id);
});

test("adding a chat while another tile is switching does not revert that tile", async () => {
  const h = setup(); const saving = gate(); const release = gate(); let paused = false;
  h.beforeUpdate = async (key) => { if (key === CHATS && !paused) { paused = true; saving.resolve(); await release.promise; } };
  const first = h.send({ type: "selectChatProject", chatId: h.slots[0].chatId, projectPath: h.projects[1].id });
  await saving.promise;
  const second = h.send({ type: "createChat", projectPath: h.projects[2].id });
  await tick(); release.resolve(); await Promise.all([first, second]);
  assert.equal(h.p.getChatSlots().length, 5);
  assert.equal(h.p.findChatSlot(h.slots[0].chatId).projectPath, h.projects[1].id);
});

test("another extension window's persisted layout cannot replace this window's visible tiles", () => {
  const h = setup();
  const original = h.p.getChatSlots();
  h.data.set(CHATS, []);
  assert.deepEqual(h.p.getChatSlots(), original);
});

test("restoring a board repairs missing session records without dropping its tile identities", async () => {
  const h = setup();
  h.data.get(STORE)[h.projects[0].id].sessions = [];
  assert.equal(h.p.getChatSlots().length, 4, "missing history must not silently close a tile");
  await h.p.ensureMultiChats();
  const restored = h.p.getChatSlots();
  assert.deepEqual(restored.map((slot) => slot.chatId), h.slots.map((slot) => slot.chatId));
  assert.ok(restored.every((slot) => h.p.getProjectStore(slot.projectPath).sessions.some((rec) => rec.id === slot.recordId)));
  assert.equal(new Set(restored.map((slot) => slot.recordId)).size, 4);
});

test("history deletion cannot remove a session while one of its tiles is running", async () => {
  const h = setup(); h.records[0].items = [{ role: "user", text: "running" }];
  h.p.runs.set(h.slots[0].chatId, new AbortController());
  await h.p.showSessions();
  await h.deleteItem({ item: { sessionId: h.records[0].id } });
  assert.ok(h.p.getProjectStore(h.projects[0].id).sessions.some((rec) => rec.id === h.records[0].id));
  assert.equal(h.p.getChatSlots().length, 4);
  assert.ok(h.messages.some((message) => message.type === "error"));
});

test("removing a tile during another selection keeps that removal and the selected project", async () => {
  const h = setup(); const saving = gate(); const release = gate(); let paused = false;
  h.beforeUpdate = async (key) => { if (key === CHATS && !paused) { paused = true; saving.resolve(); await release.promise; } };
  const first = h.send({ type: "selectChatProject", chatId: h.slots[0].chatId, projectPath: h.projects[1].id });
  await saving.promise;
  const second = h.send({ type: "removeChat", chatId: h.slots[1].chatId });
  await tick(); release.resolve(); await Promise.all([first, second]);
  assert.equal(h.p.getChatSlots().length, 3);
  assert.equal(h.p.findChatSlot(h.slots[1].chatId), undefined);
  assert.equal(h.p.findChatSlot(h.slots[0].chatId).projectPath, h.projects[1].id);
});

test("a new blank tile session has a fresh identity and rejects delayed writes to the old one", async () => {
  const h = setup(); const previous = { ...h.p.findChatSlot(h.slots[0].chatId) };
  await h.send({ type: "newSession", chatId: previous.chatId });
  const selected = h.p.findChatSlot(previous.chatId);
  assert.notEqual(selected.recordId, previous.recordId);
  await h.send({ type: "saveTranscript", chatId: previous.chatId, path: previous.projectPath, recordId: previous.recordId, items: [{ role: "user", text: "stale before reset" }] });
  assert.deepEqual(h.p.getProjectStore(selected.projectPath).sessions.find((rec) => rec.id === selected.recordId).items, []);
});

test("multi-chat transcript writes without a record identity are rejected", async () => {
  const h = setup(); const selected = h.slots[0];
  await h.send({ type: "saveTranscript", chatId: selected.chatId, path: selected.projectPath, items: [{ role: "user", text: "unbound" }] });
  assert.deepEqual(h.p.getProjectStore(selected.projectPath).sessions.find((rec) => rec.id === selected.recordId).items, []);
});

test("settings belong to the requesting tile's project instead of the legacy active project", async () => {
  const h = setup(); const selected = h.slots[0];
  h.p.context.secrets = { get: async () => undefined };
  await h.send({ type: "selectChatProject", chatId: selected.chatId, projectPath: h.projects[1].id });
  h.messages.length = 0;
  await h.send({ type: "getSettings", chatId: selected.chatId });
  const snapshots = h.messages.filter((message) => message.type === "settings");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].chatId, selected.chatId);
  assert.equal(snapshots[0].settings.project.id, h.projects[1].id);
});

test("project picker changes only the requesting tile and leaves legacy selection untouched", async () => {
  const h = setup(); const selected = h.slots[0];
  await h.send({ type: "manageProjects", chatId: selected.chatId });
  h.quickPick.selectedItems = [{ path: h.projects[2].id }];
  await h.acceptItem();
  assert.equal(h.p.findChatSlot(selected.chatId).projectPath, h.projects[2].id);
  assert.ok(h.p.getChatSlots().slice(1).every((slot) => slot.projectPath === h.projects[0].id));
  assert.equal(h.p.getActiveProject().id, h.projects[0].id);
});

function backendFixture(h, finished) {
  h.projects.forEach((project) => { project.path = temp; });
  h.p.context.secrets = { get: async () => undefined };
  h.p.directoryRuns = new Map(); h.p.sessionWriters = new Map();
  h.p.relocateAttachments = async (_cwd, attachments) => attachments;
  h.p.autoPull = async () => {}; h.p.autoCommit = async () => {};
  h.p.getSecretEnv = async () => ({}); h.p.buildProjectCard = async () => "fixture project";
  h.p.buildAgentConfig = () => ({ contextWindow: 0 });
  h.starts = [];
  h.p.backends = { claude: { async *start(prompt, options) {
    h.starts.push({ prompt, options });
    await finished.promise;
    yield { kind: "result", ok: false };
  } } };
}
async function until(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) { if (predicate()) return; await tick(); }
  assert.fail("expected backend state was not reached");
}

test("run admission waits for a pending new session without blocking other tiles for the running turn", { timeout: 5000 }, async () => {
  const h = setup(); const selected = h.slots[0]; const saving = gate(); const release = gate(); const finished = gate();
  backendFixture(h, finished);
  h.records[0].items = [{ role: "user", text: "old task" }];
  h.records[0].agentIds.claude = "old-cli-session";
  let paused = false;
  h.beforeUpdate = async (key) => { if (key === STORE && !paused) { paused = true; saving.resolve(); await release.promise; } };
  const switching = h.send({ type: "newSession", chatId: selected.chatId });
  await saving.promise;
  const turn = h.p.runTurn("new task", "claude", [], selected.projectPath, true, undefined, selected.chatId);
  try {
    await tick();
    assert.equal(h.p.runs.has(selected.chatId), false, "admission must not capture the old binding during its replacement");
    release.resolve(); await switching;
    await until(() => h.starts.length > 0);
    assert.equal(h.starts[0].options.resumeSessionId, undefined, "the backend must use the new blank record");
    await h.send({ type: "selectChatProject", chatId: h.slots[1].chatId, projectPath: h.projects[1].id });
    assert.equal(h.p.findChatSlot(h.slots[1].chatId).projectPath, h.projects[1].id);
  } finally { release.resolve(); finished.resolve(); await switching; await turn; }
});

test("sending immediately after project selection uses the confirmed project binding", { timeout: 5000 }, async () => {
  const h = setup(); const selected = h.slots[0]; const saving = gate(); const release = gate(); const finished = gate();
  backendFixture(h, finished);
  let paused = false;
  h.beforeUpdate = async (key) => { if (key === STORE && !paused) { paused = true; saving.resolve(); await release.promise; } };
  const switching = h.send({ type: "selectChatProject", chatId: selected.chatId, projectPath: h.projects[1].id });
  await saving.promise;
  const turn = h.p.runTurn("new project task", "claude", [], h.projects[1].id, true, undefined, selected.chatId);
  try {
    release.resolve(); await switching;
    await until(() => h.starts.length > 0);
    assert.ok(h.messages.some((message) => message.type === "userMessage" && message.path === h.projects[1].id));
  } finally { release.resolve(); finished.resolve(); await switching; await turn; }
});

test("a busy tile explicitly rejects project selection with its actual binding", async () => {
  const h = setup(); const selected = h.slots[0];
  h.p.runs.set(selected.chatId, new AbortController());
  await h.send({ type: "selectChatProject", chatId: selected.chatId, projectPath: h.projects[1].id });
  const rejected = h.messages.find((message) => message.type === "chatProjectRejected");
  assert.ok(rejected, "UI must receive an acknowledgement that clears its pending selection");
  assert.equal(rejected.chatId, selected.chatId);
  assert.equal(rejected.requestedProjectPath, h.projects[1].id);
  assert.equal(rejected.projectPath, selected.projectPath);
  assert.equal(rejected.recordId, selected.recordId);
});

test("unknown project and persistence failure both clear pending project selections", async () => {
  const h = setup(); const selected = h.slots[0];
  await h.send({ type: "selectChatProject", chatId: selected.chatId, projectPath: "project-removed" });
  assert.equal(h.messages.find((message) => message.type === "chatProjectRejected")?.requestedProjectPath, "project-removed");
  h.messages.length = 0;
  h.beforeUpdate = async () => { throw new Error("fixture persistence failure"); };
  await h.send({ type: "selectChatProject", chatId: selected.chatId, projectPath: h.projects[1].id });
  assert.equal(h.messages.find((message) => message.type === "chatProjectRejected")?.requestedProjectPath, h.projects[1].id);
  assert.equal(h.p.findChatSlot(selected.chatId).projectPath, selected.projectPath);
});
