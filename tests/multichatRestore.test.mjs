import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-multichat-restore-"));
const stubKey = Symbol.for("agent-hub-multichat-restore-tests");
let current;
globalThis[stubKey] = { get current() { return current; } };
after(async () => { delete globalThis[stubKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-multichat-restore", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-multichat-restore-tests")].current';
      if (path === "vscode") return { contents: `export const workspace={getConfiguration:()=>({get:(_key,fallback)=>fallback})};export const window={createWebviewPanel:()=>${h}.createPanel()};export const Uri={joinPath:(...parts)=>parts.join("/")},commands={},ViewColumn={One:1},ConfigurationTarget={},ProgressLocation={},env={};export class ThemeIcon{};` };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected external process")};' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>"";export const buildFinishPrompt=()=>"";' };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{};export const enableTailscaleFunnel=()=>{};export const generateToken=()=>"";export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>"";export default {};' };
      return { contents: 'export class ClaudeBackend{};export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{};export const codexDefaultModel=()=>"test";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
const extensionOutfile = join(temp, "extension.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))],
  outfile: extensionOutfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-serializer-registration", setup(b) {
    b.onResolve({ filter: /^(vscode|\.\/ChatViewProvider)$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-multichat-restore-tests")].current';
      if (path === "vscode") return { contents: `export const window={registerWebviewViewProvider:()=>({}),registerWebviewPanelSerializer:(id,serializer)=>{${h}.serializer={id,...serializer};return{}}};export const commands={registerCommand:()=>({})};` };
      return { contents: `export class ChatViewProvider {static viewId="agentHub.chat";static multiViewId="agentHub.multiChat";restoreMultiChatPanel(panel,state){${h}.restored={panel,state};return Promise.resolve();}}` };
    });
  } }],
});
const { activate } = await import(pathToFileURL(extensionOutfile).href);
const STORE = "agentHub.sessionStore";
const CHATS = "agentHub.multiChats";
const copy = (value) => value === undefined ? undefined : structuredClone(value);
function memento(data) {
  return { keys: () => [...data.keys()], get: (key, fallback) => data.has(key) ? copy(data.get(key)) : fallback, update: async (key, value) => { value === undefined ? data.delete(key) : data.set(key, copy(value)); } };
}
function panelFixture() {
  const messages = [], receives = new Set(), disposals = new Set();
  const panel = {
    messages, receives, disposals, reveals: 0, disposed: false,
    webview: { options: {}, html: "", postMessage: (message) => { messages.push(message); },
      onDidReceiveMessage: (fn) => { receives.add(fn); return { dispose: () => receives.delete(fn) }; } },
    onDidDispose: (fn) => { disposals.add(fn); return { dispose: () => disposals.delete(fn) }; },
    reveal() { panel.reveals++; },
    dispose() { panel.disposed = true; for (const fn of [...disposals]) fn(); },
    async send(message) { for (const fn of receives) await fn(message); },
  };
  return panel;
}
function setup({ global = new Map(), workspace = new Map(), archived = false } = {}) {
  const projects = [
    { id: "project-alpha", path: join(temp, "alpha"), name: "Alpha" },
    { id: "project-beta", path: join(temp, "beta"), name: "Бета 🗂", ...(archived ? { archive: { path: join(temp, "Archive", "beta"), archivedAt: 1 } } : {}) },
  ];
  const records = projects.map((project, i) => ({ id: `record-${i}`, title: `Session ${i}`, createdAt: 1, updatedAt: 1, agentIds: { claude: `claude-${i}`, codex: `codex-${i}` }, items: [{ role: "user", text: `Transcript ${i}` }] }));
  if (!global.has(STORE)) global.set(STORE, Object.fromEntries(projects.map((project, i) => [project.id, { activeId: records[i].id, sessions: [records[i]] }])));
  const h = { global, workspace, projects, records, panels: [] };
  h.createPanel = () => { const panel = panelFixture(); h.panels.push(panel); return panel; };
  current = h;
  const p = Object.create(ChatViewProvider.prototype);
  p.context = { globalState: memento(global), workspaceState: memento(workspace), extensionUri: "extension", subscriptions: [] };
  p.getAllProjects = () => projects; p.getProjects = () => projects.filter((project) => !project.archive); p.getArchivedProjects = () => projects.filter((project) => project.archive); p.getActiveProject = () => projects[0];
  p.runs = new Map(); p.pendingPermissions = new Map();
  p.postRuntimeSettings = () => {}; p.post = () => {}; p.renderHtml = (_webview, surface) => `<html>${surface}</html>`;
  h.p = p;
  h.slots = [
    { chatId: "chat-restore-beta", projectPath: projects[1].id, recordId: records[1].id, agent: "codex" },
    { chatId: "chat-restore-alpha", projectPath: projects[0].id, recordId: records[0].id, agent: "claude" },
  ];
  return h;
}

test("a restarted workspace restores its own ordered projects, sessions and providers after another window saved", async () => {
  const h = setup();
  await h.p.saveChatSlots(h.slots);
  const other = setup({ global: h.global });
  await other.p.saveChatSlots([other.slots[1]]);
  const restarted = setup({ global: h.global, workspace: h.workspace });
  await restarted.p.openMultiChat();
  assert.deepEqual(restarted.p.getChatSlots(), h.slots);
  assert.equal(restarted.panels[0].messages.filter((message) => message.type === "transcript").length, 2);
  assert.equal(Object.values(h.global.get(STORE)).reduce((sum, store) => sum + store.sessions.length, 0), 2);
});

test("legacy global layout migrates once and a later foreign snapshot cannot replace it", async () => {
  const h = setup({ archived: true }); h.global.set(CHATS, h.slots);
  await h.p.openMultiChat();
  assert.deepEqual(h.workspace.get(CHATS), h.slots);
  h.global.set(CHATS, []);
  const restarted = setup({ global: h.global, workspace: h.workspace, archived: true });
  await restarted.p.openMultiChat();
  assert.deepEqual(restarted.p.getChatSlots(), h.slots);
  assert.equal(restarted.panels[0].messages.filter((message) => message.type === "transcript").length, 1, "archived tile remains without running or hydrating its transcript");
});

test("closing every tile persists an intentionally empty space across restart", async () => {
  const h = setup(); await h.p.saveChatSlots(h.slots);
  for (const slot of h.slots) await h.p.removeMultiChat(slot.chatId);
  const restarted = setup({ global: h.global, workspace: h.workspace });
  await restarted.p.openMultiChat();
  assert.deepEqual(restarted.p.getChatSlots(), []);
  assert.deepEqual(restarted.panels[0].messages.find((message) => message.type === "multiState")?.chats, []);
  assert.equal(Object.values(h.global.get(STORE)).reduce((sum, store) => sum + store.sessions.length, 0), 2);
});

test("a first board without any saved layout still creates the default four independent chats", async () => {
  const h = setup(); await h.p.openMultiChat();
  assert.equal(h.p.getChatSlots().length, 4);
  assert.equal(new Set(h.p.getChatSlots().map((slot) => slot.recordId)).size, 4);
  assert.deepEqual(h.workspace.get(CHATS), h.p.getChatSlots());
});

test("restored panel metadata wins over a different window in the same workspace", async () => {
  const h = setup({ archived: true }); h.workspace.set(CHATS, [h.slots[1]]); h.global.set(CHATS, []);
  const panel = panelFixture();
  await h.p.restoreMultiChatPanel(panel, { version: 1, chats: h.slots });
  assert.equal(h.panels.length, 0, "deserialize binds the panel supplied by VS Code");
  assert.equal(h.p.multiPanel, panel);
  assert.deepEqual(h.p.getChatSlots(), h.slots);
  assert.deepEqual(h.workspace.get(CHATS), h.slots);
  assert.match(panel.webview.html, /multi-panel/);
  assert.equal(panel.webview.options.enableScripts, true);
  assert.equal(panel.receives.size, 1);
  await panel.send({ type: "multiStateReady", chatIds: [] });
  assert.deepEqual(panel.messages.find((message) => message.type === "multiState").chats.map(({ title, ...slot }) => slot), h.slots);
  assert.equal(Object.values(h.global.get(STORE)).reduce((sum, store) => sum + store.sessions.length, 0), 2);
  assert.equal(h.p.runs.size, 0);
});

test("an explicit empty serialized panel remains empty even if workspace has four tiles", async () => {
  const h = setup(); h.workspace.set(CHATS, h.slots);
  const panel = panelFixture(); await h.p.restoreMultiChatPanel(panel, { version: 1, chats: [] });
  assert.deepEqual(h.p.getChatSlots(), []);
  assert.equal(panel.messages.at(-1).type, "multiState");
  assert.deepEqual(panel.messages.at(-1).chats, []);
});

test("malformed serializer state falls back safely to the existing workspace", async () => {
  for (const state of [null, undefined, "bad", { version: 2, chats: [] }, { version: 1, chats: null }]) {
    const h = setup(); h.workspace.set(CHATS, h.slots);
    await h.p.restoreMultiChatPanel(panelFixture(), state);
    assert.deepEqual(h.p.getChatSlots(), h.slots);
  }
});

test("serialized slots discard unknown projects, malformed entries and duplicate chat identities", async () => {
  const h = setup(); const slot = h.slots[1];
  await h.p.restoreMultiChatPanel(panelFixture(), { version: 1, chats: [slot, slot, null, { ...slot, chatId: "invalid" }, { ...slot, chatId: "chat-unknown-project", projectPath: "missing" }, { ...slot, chatId: "chat-missing-record", recordId: "" }, { ...slot, chatId: "chat-invalid-agent", agent: "other" }] });
  assert.deepEqual(h.p.getChatSlots(), [slot]);
});

test("restoring the same panel twice does not duplicate handlers, sessions or tiles", async () => {
  const h = setup(); const panel = panelFixture();
  await h.p.restoreMultiChatPanel(panel, { version: 1, chats: h.slots });
  await h.p.restoreMultiChatPanel(panel, { version: 1, chats: [] });
  assert.equal(panel.receives.size, 1);
  assert.deepEqual(h.p.getChatSlots(), h.slots);
  await h.p.openMultiChat();
  assert.equal(h.panels.length, 0);
  assert.equal(panel.reveals, 1);
  panel.dispose();
  assert.equal(panel.receives.size, 0);
  assert.equal(h.p.multiPanel, null);
  await h.p.openMultiChat();
  assert.equal(h.panels.length, 1);
  assert.deepEqual(h.p.getChatSlots(), h.slots);
});

test("late restored duplicate panel cannot overwrite a board already opened by the user", async () => {
  const h = setup(); await h.p.saveChatSlots(h.slots); await h.p.openMultiChat();
  const activePanel = h.p.multiPanel; const duplicate = panelFixture();
  await h.p.restoreMultiChatPanel(duplicate, { version: 1, chats: [] });
  assert.equal(duplicate.disposed, true);
  assert.equal(h.p.multiPanel, activePanel);
  assert.deepEqual(h.p.getChatSlots(), h.slots);
});

test("serializer activation is declared and registered during extension activation", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.activationEvents.includes("onWebviewPanel:agentHub.multiChat"));
  const h = setup(); activate({ subscriptions: [] });
  assert.equal(h.serializer.id, "agentHub.multiChat");
  const panel = panelFixture(), state = { version: 1, chats: h.slots };
  await h.serializer.deserializeWebviewPanel(panel, state);
  assert.deepEqual(h.restored, { panel, state });
});

test("opening another workspace's history cannot prune a saved blank tile or its model choice", async () => {
  const h = setup(); const store = h.global.get(STORE)[h.projects[0].id];
  store.activeId = null; store.sessions[0].items = []; store.sessions[0].modelOverrides = { codex: "my-model" };
  await h.p.saveChatSlots([h.slots[1]]);
  const other = setup({ global: h.global }); await other.p.saveChatSlots([other.slots[0]]);
  const shared = other.p.getProjectStore(h.projects[0].id);
  other.p.pruneEmptySessions(shared, h.projects[0].id);
  await other.p.saveProjectStore(h.projects[0].id, shared);
  assert.deepEqual(shared.sessions.find((record) => record.id === h.slots[1].recordId)?.modelOverrides, { codex: "my-model" });
});

test("the history cap in another workspace retains old records used by a saved board", async () => {
  const h = setup(); const store = h.global.get(STORE)[h.projects[0].id];
  store.sessions.push(...Array.from({ length: 35 }, (_, index) => ({ ...h.records[0], id: `other-history-${index}`, updatedAt: index + 10 })));
  store.activeId = "other-history-34";
  await h.p.saveChatSlots([h.slots[1]]);
  const other = setup({ global: h.global }); await other.p.saveChatSlots([other.slots[0]]);
  await other.p.newSession();
  assert.ok(other.p.getProjectStore(h.projects[0].id).sessions.some((record) => record.id === h.slots[1].recordId));
});

test("a legacy blank active reset cannot erase the CLI identity of a saved board", async () => {
  const h = setup(); const store = h.global.get(STORE)[h.projects[0].id];
  store.sessions[0].items = []; store.sessions[0].modelOverrides = { codex: "my-model" };
  await h.p.saveChatSlots([h.slots[1]]);
  const other = setup({ global: h.global }); await other.p.saveChatSlots([other.slots[0]]);
  await other.p.newSession();
  const original = other.p.getProjectStore(h.projects[0].id).sessions.find((record) => record.id === h.slots[1].recordId);
  assert.deepEqual(original?.modelOverrides, { codex: "my-model" });
  assert.equal(original?.agentIds.codex, "codex-0");
});

test("independent boards use distinct pin identities and a serialized panel keeps its original identity", async () => {
  const h = setup(); await h.p.saveChatSlots(h.slots); await h.p.openMultiChat();
  const boardId = h.p.multiPanel.messages.find((message) => message.type === "multiState").boardId;
  assert.match(boardId, /^board-[a-z0-9-]+$/);
  const other = setup({ global: h.global, workspace: h.workspace }); await other.p.openMultiChat();
  const otherBoardId = other.p.multiPanel.messages.find((message) => message.type === "multiState").boardId;
  assert.notEqual(otherBoardId, boardId);
  const restored = setup({ global: h.global, workspace: h.workspace });
  const panel = panelFixture(); await restored.p.restoreMultiChatPanel(panel, { version: 1, boardId, chats: h.slots });
  assert.equal(panel.messages.find((message) => message.type === "multiState").boardId, boardId);
  await restored.p.saveChatSlots([]);
  const pinned = restored.p.savedBoardRecordIds(h.projects[0].id);
  assert.ok(pinned.has(h.records[0].id), "another board still pins the shared record");
  await other.p.saveChatSlots([]);
  assert.equal(other.p.savedBoardRecordIds(h.projects[0].id).has(h.records[0].id), false);
});

test("both old and replacement records stay protected during a delayed workspace write", async () => {
  const h = setup(); const original = h.slots[1]; await h.p.saveChatSlots([original]);
  const other = setup({ global: h.global }); await other.p.saveChatSlots([]);
  const replacement = { ...original, recordId: "record-replacement" };
  h.p.context.workspaceState.update = async () => {
    const pinned = other.p.savedBoardRecordIds(original.projectPath);
    assert.ok(pinned.has(original.recordId));
    assert.ok(pinned.has(replacement.recordId));
  };
  await h.p.saveChatSlots([replacement]);
  assert.deepEqual([...other.p.savedBoardRecordIds(original.projectPath)], [replacement.recordId]);
});

test("failed serialized restoration keeps the original board pins instead of foreign workspace bindings", async () => {
  const h = setup(); await h.p.saveChatSlots([h.slots[1]]);
  const boardId = h.p.multiBoardId;
  const other = setup({ global: h.global, workspace: h.workspace }); await other.p.saveChatSlots([h.slots[0]]);
  const restored = setup({ global: h.global, workspace: h.workspace });
  restored.p.context.workspaceState.update = async () => { throw new Error("workspace unavailable"); };
  await assert.rejects(restored.p.restoreMultiChatPanel(panelFixture(), { version: 1, boardId, chats: [h.slots[1]] }), /workspace unavailable/);
  assert.ok(h.global.get(`agentHub.multiBoard.${boardId}`).some((slot) =>
    slot.projectPath === h.slots[1].projectPath && slot.recordId === h.slots[1].recordId),
  "the original board's history remains protected even when persistence and its rollback fail");
  assert.equal(restored.p.multiPanel, undefined, "failed restore never starts a partial runnable panel");
});

test("failed workspace save retains the current live and durable layout", async () => {
  const h = setup(); await h.p.saveChatSlots(h.slots);
  h.p.context.workspaceState.update = async () => { throw new Error("workspace unavailable"); };
  await assert.rejects(h.p.saveChatSlots([]), /workspace unavailable/);
  assert.deepEqual(h.p.getChatSlots(), h.slots);
  assert.deepEqual(h.workspace.get(CHATS), h.slots);
});

test("missing saved records are repaired once without duplicating the restored panel's sessions", async () => {
  const h = setup(); const missing = { ...h.slots[1], recordId: "removed-history-record" };
  const panel = panelFixture(); await h.p.restoreMultiChatPanel(panel, { version: 1, chats: [missing] });
  const [slot] = h.p.getChatSlots();
  assert.equal(slot.chatId, missing.chatId); assert.notEqual(slot.recordId, missing.recordId);
  assert.equal(h.p.getProjectStore(slot.projectPath).sessions.filter((record) => record.id === slot.recordId).length, 1);
  await panel.send({ type: "multiStateReady", chatIds: [slot.chatId] });
  assert.equal(h.p.getProjectStore(slot.projectPath).sessions.filter((record) => record.id === slot.recordId).length, 1);
});

test("the same board's committed removal wins over an older panel snapshot after restart", async () => {
  const h = setup(); await h.p.saveChatSlots(h.slots);
  const snapshot = { version: 1, boardId: h.p.multiBoardId, chats: copy(h.slots) };
  await h.p.saveChatSlots([h.slots[1]]);
  const restored = setup({ global: h.global, workspace: h.workspace });
  await restored.p.restoreMultiChatPanel(panelFixture(), snapshot);
  assert.deepEqual(restored.p.getChatSlots(), [h.slots[1]]);
});

test("the same board's committed empty space wins over an older nonempty panel snapshot", async () => {
  const h = setup(); await h.p.saveChatSlots(h.slots);
  const snapshot = { version: 1, boardId: h.p.multiBoardId, chats: copy(h.slots) };
  await h.p.saveChatSlots([]);
  const restored = setup({ global: h.global, workspace: h.workspace });
  await restored.p.restoreMultiChatPanel(panelFixture(), snapshot);
  assert.deepEqual(restored.p.getChatSlots(), []);
});

test("the same board's latest project, session and provider bindings win over stale browser state", async () => {
  const h = setup(); await h.p.saveChatSlots(h.slots);
  const snapshot = { version: 1, boardId: h.p.multiBoardId, chats: copy(h.slots) };
  const latest = [{ ...h.slots[0], projectPath: h.slots[1].projectPath, recordId: h.slots[1].recordId, agent: "claude" }];
  await h.p.saveChatSlots(latest);
  const other = setup({ global: h.global, workspace: h.workspace }); await other.p.saveChatSlots([h.slots[0]]);
  const restored = setup({ global: h.global, workspace: h.workspace });
  await restored.p.restoreMultiChatPanel(panelFixture(), snapshot);
  assert.deepEqual(restored.p.getChatSlots(), latest, "own durable board outranks both stale panel and another window's workspace save");
});

test("failed canonical board commit rolls back the workspace, live layout and old board snapshot", async () => {
  const h = setup(); await h.p.saveChatSlots(h.slots);
  const boardKey = `agentHub.multiBoardLayout.${h.p.multiBoardId}`;
  const original = copy(h.global.get(boardKey));
  const update = h.p.context.globalState.update;
  let failed = false;
  h.p.context.globalState.update = async (key, value) => {
    if (key === boardKey && !failed) { failed = true; throw new Error("canonical store unavailable"); }
    await update(key, value);
  };
  await assert.rejects(h.p.saveChatSlots([]), /canonical store unavailable/);
  assert.deepEqual(h.p.getChatSlots(), h.slots);
  assert.deepEqual(h.workspace.get(CHATS), h.slots);
  assert.deepEqual(h.global.get(boardKey), original);
  assert.deepEqual(h.global.get(`agentHub.multiBoard.${h.p.multiBoardId}`), h.slots);
});

test("manual opening after a failed restoration cannot overwrite the failed panel's board identity", async () => {
  const h = setup(); await h.p.saveChatSlots([h.slots[1]]);
  const boardId = h.p.multiBoardId;
  const original = copy(h.global.get(`agentHub.multiBoardLayout.${boardId}`));
  const other = setup({ global: h.global, workspace: h.workspace }); await other.p.saveChatSlots([h.slots[0]]);
  const restored = setup({ global: h.global, workspace: h.workspace });
  const update = restored.p.context.workspaceState.update;
  let failed = false;
  restored.p.context.workspaceState.update = async (key, value) => {
    if (!failed) { failed = true; throw new Error("transient workspace failure"); }
    await update(key, value);
  };
  await assert.rejects(restored.p.restoreMultiChatPanel(panelFixture(), { version: 1, boardId, chats: [h.slots[1]] }), /transient workspace failure/);
  await restored.p.openMultiChat();
  assert.notEqual(restored.p.multiBoardId, boardId);
  assert.deepEqual(h.global.get(`agentHub.multiBoardLayout.${boardId}`), original);
  assert.deepEqual(h.global.get(`agentHub.multiBoard.${boardId}`), [h.slots[1]]);
});

test("partial persistence rollback retains pins for every potentially durable binding", async () => {
  const h = setup(); const original = h.slots[1]; await h.p.saveChatSlots([original]);
  const replacement = { ...original, recordId: "record-potentially-durable" };
  const boardKey = `agentHub.multiBoardLayout.${h.p.multiBoardId}`;
  const globalUpdate = h.p.context.globalState.update;
  let canonicalFailed = false;
  h.p.context.globalState.update = async (key, value) => {
    if (key === boardKey && !canonicalFailed) { canonicalFailed = true; throw new Error("canonical save failure"); }
    await globalUpdate(key, value);
  };
  const workspaceUpdate = h.p.context.workspaceState.update;
  let workspaceWrites = 0;
  h.p.context.workspaceState.update = async (key, value) => {
    if (++workspaceWrites === 2) throw new Error("workspace rollback failure");
    await workspaceUpdate(key, value);
  };
  await assert.rejects(h.p.saveChatSlots([replacement]), /canonical save failure/);
  assert.deepEqual(h.workspace.get(CHATS), [replacement]);
  const other = setup({ global: h.global });
  const protectedIds = other.p.savedBoardRecordIds(original.projectPath);
  assert.ok(protectedIds.has(original.recordId));
  assert.ok(protectedIds.has(replacement.recordId), "the workspace still references this record after its rollback failed");
});
