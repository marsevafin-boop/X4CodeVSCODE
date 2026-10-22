import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-multichat-preferences-"));
const stubKey = Symbol.for("agent-hub-multichat-preferences-tests");
let current;
globalThis[stubKey] = { get current() { return current; } };
after(async () => { delete globalThis[stubKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-multichat-preferences", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-multichat-preferences-tests")].current';
      if (path === "vscode") return { contents: `export const workspace={getConfiguration:(section)=>${h}.configuration(section)};export const window={showWarningMessage:async()=>"Включить"};export const Uri={},commands={},ViewColumn={},ConfigurationTarget={Global:1},ProgressLocation={},env={}; export class ThemeIcon{};` };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected external process")};' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>""; export const buildFinishPrompt=()=>"";' };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{};export const enableTailscaleFunnel=()=>{};export const generateToken=()=>"";export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>"";export default {};' };
      return { contents: 'export class ClaudeBackend{};export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{};export const codexDefaultModel=()=>"codex-cli-default";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
const STORE = "agentHub.sessionStore";
const CHATS = "agentHub.multiChats";
function setup() {
  const projects = ["one", "two"].map((name) => ({ id: `project-${name}`, path: join(temp, name), name }));
  const records = Array.from({ length: 2 }, (_, i) => ({ id: `record-${i}`, title: "Новая сессия", createdAt: 1, updatedAt: 1, agentIds: { claude: null, codex: null }, items: [] }));
  const slots = records.map((rec, i) => ({ chatId: `chat-fixture-${i}`, projectPath: projects[0].id, recordId: rec.id, agent: "claude" }));
  const data = new Map([[CHATS, slots], [STORE, { [projects[0].id]: { activeId: null, sessions: records } }]]);
  const settings = { "claude.model": "claude-base", "claude.effort": "max", "claude.permissionMode": "bypassPermissions", "codex.model": "codex-base", "codex.effort": "ultra", "codex.yolo": true, "codex.sandbox": "danger-full-access", autoScrollMode: "allOff" };
  const h = { data, projects, records, slots, settings, messages: [], settingsRequests: [] };
  h.configuration = (section) => {
    const key = (name) => section === "agentHub" ? name : `${section.replace(/^agentHub\./, "")}.${name}`;
    return { get: (name, fallback) => settings[key(name)] ?? fallback, update: async (name, value) => { settings[key(name)] = value; } };
  };
  current = h;
  const p = Object.create(ChatViewProvider.prototype);
  p.context = { globalState: { get: (key, fallback) => data.has(key) ? data.get(key) : fallback, update: async (key, value) => { data.set(key, value); } } };
  p.getAllProjects = () => projects; p.getProjects = () => projects; p.getActiveProject = () => projects[0];
  p.runs = new Map(); p.pendingPermissions = new Map();
  p.multiPanel = { webview: { postMessage: (message) => h.messages.push(message) } };
  p.post = (message) => h.messages.push(message);
  p.postSettings = async (chatId) => h.settingsRequests.push(chatId);
  p.listCodexPrompts = () => [];
  h.p = p;
  h.send = (message) => p.onMessage(message, "vscode", undefined, "multi-panel");
  h.model = (chatId, agent) => h.messages.filter((message) => message.type === "modelInfo" && message.chatId === chatId && message.agent === agent).at(-1);
  h.selectedRecord = (chatId) => { const slot = p.findChatSlot(chatId); return p.getProjectStore(slot.projectPath).sessions.find((rec) => rec.id === slot.recordId); };
  return h;
}

test("ready loads saved efforts, permissions, scrolling and slash commands into multichat", async () => {
  const h = setup();
  await h.send({ type: "ready", chatId: h.slots[0].chatId });
  for (const [agent, effort] of [["claude", "max"], ["codex", "ultra"]]) {
    assert.ok(h.messages.some((message) => message.type === "effortInfo" && message.agent === agent && message.effort === effort));
    assert.ok(h.messages.some((message) => message.type === "safetyInfo" && message.agent === agent && message.dangerous));
    assert.ok(h.messages.some((message) => message.type === "slashCommands" && message.agent === agent));
  }
  assert.ok(h.messages.some((message) => message.type === "autoScrollMode" && message.mode === "allOff"));
});

test("blank tile model badges load their override or saved base model before any run", async () => {
  const h = setup(); h.records[0].modelOverrides = { codex: "codex-tile" };
  await h.send({ type: "ready", chatId: h.slots[0].chatId });
  assert.equal(h.model(h.slots[0].chatId, "claude").model, "claude-base");
  assert.equal(h.model(h.slots[0].chatId, "codex").model, "codex-tile");
  delete h.settings["codex.model"]; h.records[0].modelOverrides = {};
  await h.send({ type: "ready", chatId: h.slots[0].chatId });
  assert.equal(h.model(h.slots[0].chatId, "codex").model, "codex-cli-default");
});

test("hydration preserves actual fallback telemetry until an explicit model change", async () => {
  const h = setup(); h.records[0].modelOverrides = { codex: "requested-model" };
  h.records[0].models = { codex: "actual-fallback" }; h.records[0].modelFallbacks = { codex: "requested-model" };
  await h.send({ type: "ready", chatId: h.slots[0].chatId });
  assert.equal(h.model(h.slots[0].chatId, "codex").model, "actual-fallback");
  assert.equal(h.model(h.slots[0].chatId, "codex").fallbackFrom, "requested-model");
});

test("a model selection updates only its tile immediately and clears stale fallback telemetry", async () => {
  const h = setup(); const chatId = h.slots[0].chatId;
  h.records[0].models = { codex: "stale-fallback" }; h.records[0].modelFallbacks = { codex: "stale-request" };
  await h.p.applyModel("codex", "chosen-model", false, chatId);
  assert.equal(h.model(chatId, "codex")?.model, "chosen-model");
  assert.equal(h.model(chatId, "codex")?.fallbackFrom, undefined);
  assert.equal(h.messages.some((message) => message.type === "modelInfo" && message.chatId !== chatId), false);
  assert.equal(h.messages.some((message) => message.type === "transcript"), false);
  assert.deepEqual(h.settingsRequests, [chatId]);
  assert.equal(h.records[0].modelFallbacks?.codex, undefined);
});

test("New Session preserves tile model choices while resetting transcript and CLI identity", async () => {
  const h = setup(); const chatId = h.slots[0].chatId;
  const overrides = { claude: "claude-tile", codex: "codex-tile" };
  h.records[0].modelOverrides = overrides; h.records[0].agentIds.codex = "old-thread";
  await h.send({ type: "newSession", chatId });
  const fresh = h.selectedRecord(chatId);
  assert.notEqual(fresh.id, h.records[0].id);
  assert.deepEqual(fresh.modelOverrides, overrides);
  assert.notEqual(fresh.modelOverrides, overrides);
  assert.equal(fresh.agentIds.codex, null);
  assert.deepEqual(fresh.items, []);
  assert.equal(h.model(chatId, "codex").model, "codex-tile");
});

test("switching a tile project retains its provider and model choices", async () => {
  const h = setup(); const chatId = h.slots[0].chatId;
  h.slots[0].agent = "codex"; h.records[0].modelOverrides = { codex: "codex-tile" };
  await h.send({ type: "selectChatProject", chatId, projectPath: h.projects[1].id });
  assert.equal(h.p.findChatSlot(chatId).agent, "codex");
  assert.deepEqual(h.selectedRecord(chatId).modelOverrides, { codex: "codex-tile" });
  assert.equal(h.model(chatId, "codex").model, "codex-tile");
});

test("new tiles inherit the last chosen provider without changing other tiles", async () => {
  const h = setup();
  await h.send({ type: "selectChatAgent", chatId: h.slots[0].chatId, agent: "codex" });
  await h.send({ type: "createChat", projectPath: h.projects[0].id });
  const live = h.p.getChatSlots();
  assert.equal(live.find((slot) => slot.chatId === h.slots[0].chatId).agent, "codex");
  assert.equal(live.find((slot) => slot.chatId === h.slots[1].chatId).agent, "claude");
  assert.equal(live.at(-1).agent, "codex");
  assert.equal(h.data.get("agentHub.multiPreferredAgent"), "codex");
  h.data.set(CHATS, []); h.p.chatSlots = undefined;
  await h.p.ensureMultiChats();
  assert.equal(h.p.getChatSlots().length, 4);
  assert.ok(h.p.getChatSlots().every((slot) => slot.agent === "codex"));
});

test("a base model change refreshes following tiles while preserving another tile's override", async () => {
  const h = setup(); const chatId = h.slots[0].chatId;
  h.records[0].modelOverrides = { codex: "old-override" };
  h.records[1].modelOverrides = { codex: "other-tile-model" };
  await h.p.applyModel("codex", "new-base", true, chatId);
  assert.equal(h.settings["codex.model"], "new-base");
  assert.equal(h.model(chatId, "codex")?.model, "new-base");
  assert.equal(h.records[0].modelOverrides?.codex, undefined);
  assert.equal(h.records[1].modelOverrides.codex, "other-tile-model");
  await h.send({ type: "ready", chatId: h.slots[1].chatId });
  assert.equal(h.model(h.slots[1].chatId, "codex").model, "other-tile-model");
});

test("effort and permissions remain persisted and hydrate again after reopening", async () => {
  const h = setup();
  await h.p.applyEffort("codex", "high");
  await h.p.cycleSafety("codex");
  h.messages.length = 0;
  await h.send({ type: "multiStateReady", chatIds: [] });
  assert.ok(h.messages.some((message) => message.type === "effortInfo" && message.agent === "codex" && message.effort === "high"));
  assert.ok(h.messages.some((message) => message.type === "safetyInfo" && message.agent === "codex" && !message.dangerous));
  assert.equal(h.settings["codex.effort"], "high");
  assert.equal(h.settings["codex.yolo"], false);
});

test("model and effort pickers resolve the tile override instead of another base model", async () => {
  const h = setup(); const chatId = h.slots[0].chatId;
  h.records[0].modelOverrides = { claude: "claude-tile" };
  h.p.listClaudeModels = () => [{ value: "claude-base", supportedEffortLevels: ["max"] }, { value: "claude-tile", supportedEffortLevels: ["low", "high"] }];
  const choices = [];
  const remote = { send: (message) => choices.push(message) };
  await h.p.pickModel("claude", remote, chatId);
  assert.equal(choices[0].items.find((item) => item.current)?.value, "claude-tile");
  await h.p.pickEffort("claude", remote, chatId);
  assert.deepEqual(choices[1].items.map((item) => item.value), ["", "low", "high"]);
});

test("revealing an existing board refreshes runtime labels and models without replaying transcripts", async () => {
  const h = setup(); let reveals = 0;
  h.p.multiPanel.reveal = () => { reveals++; };
  h.records[0].modelOverrides = { codex: "codex-tile" };
  await h.send({ type: "openMultiChat" });
  assert.equal(reveals, 1);
  assert.ok(h.messages.some((message) => message.type === "effortInfo"));
  assert.ok(h.messages.some((message) => message.type === "safetyInfo"));
  assert.equal(h.model(h.slots[0].chatId, "codex").model, "codex-tile");
  assert.equal(h.messages.some((message) => message.type === "transcript"), false);
});

test("Codex effort picker uses the tile model's supported levels", async () => {
  const h = setup(); const chatId = h.slots[0].chatId;
  h.records[0].modelOverrides = { codex: "codex-tile" };
  h.p.codexEffortLevels = (model) => [{ effort: model === "codex-tile" ? "ultra" : "low" }];
  const choices = [];
  await h.p.pickEffort("codex", { send: (message) => choices.push(message) }, chatId);
  assert.deepEqual(choices[0].items.map((item) => item.value), ["", "ultra"]);
});

test("changing the base model clears stale fallback badges only in following tiles", async () => {
  const h = setup();
  h.records.push({ ...h.records[0], id: "record-2", items: [] });
  h.slots.push({ ...h.slots[0], chatId: "chat-fixture-2", recordId: "record-2" });
  h.records[1].models = { codex: "old-fallback" };
  h.records[1].modelFallbacks = { codex: "codex-base" };
  h.records[2].modelOverrides = { codex: "tile-explicit" };
  h.records[2].models = { codex: "explicit-fallback" };
  h.records[2].modelFallbacks = { codex: "tile-explicit" };
  await h.p.applyModel("codex", "new-base", true, h.slots[0].chatId);
  assert.equal(h.model(h.slots[1].chatId, "codex").model, "new-base");
  assert.equal(h.model(h.slots[1].chatId, "codex").fallbackFrom, undefined);
  assert.equal(h.model(h.slots[2].chatId, "codex").model, "explicit-fallback");
});
