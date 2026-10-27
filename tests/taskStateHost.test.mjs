import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-task-host-"));
const stubKey = Symbol.for("agent-hub-task-host-tests");
let current;
globalThis[stubKey] = { get current() { return current; } };
after(async () => { delete globalThis[stubKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-task-host", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-task-host-tests")].current';
      if (path === "vscode") return { contents: `export const workspace={workspaceFolders:[],getConfiguration:(section)=>${h}.configuration(section)};export const window={showInformationMessage:async()=>{},showErrorMessage:(message)=>${h}.errors.push(message)};export const Uri={},commands={executeCommand:async()=>{}},ViewColumn={},ConfigurationTarget={Global:1},ProgressLocation={},env={};export class ThemeIcon{};` };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected external process")};' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>"";export const buildFinishPrompt=()=>"";' };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{};export const enableTailscaleFunnel=()=>{};export const generateToken=()=>"";export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>"";export default {};' };
      return { contents: 'export class ClaudeBackend{};export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{};export const codexDefaultModel=()=>"test-model";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
const STORE = "agentHub.sessionStore", CHATS = "agentHub.multiChats";
const fields = (overrides = {}) => ({ outcome: "Сохранить задачу 📌", scope: "Один чат", doneWhen: "После перезапуска", requiredChecks: "node --test", candidate: "", completed: "", blockers: "", nextStep: "Проверить", evidence: "", ...overrides });
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const jsonClone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function setup({ global = new Map(), workspace = new Map() } = {}) {
  const projects = ["one", "two"].map(name => ({ id: `project-${name}`, path: join(temp, "shared-folder"), name }));
  const records = [1, 2].map(n => ({ id: `record-${n}`, title: "Новая сессия", createdAt: n, updatedAt: n, agentIds: { claude: null, codex: null }, items: [] }));
  if (!global.has(STORE)) global.set(STORE, { [projects[0].id]: { activeId: records[0].id, sessions: records }, [projects[1].id]: { activeId: "other-record", sessions: [{ ...structuredClone(records[0]), id: "other-record" }] } });
  const slots = records.map((rec, i) => ({ chatId: `chat-task-slot-${i}`, projectPath: projects[0].id, recordId: rec.id, agent: "claude" }));
  if (!workspace.has(CHATS)) workspace.set(CHATS, slots);
  const values = { projects, autoCommit: false, autoPull: false, "codex.model": "test-model" };
  const durableGlobal = new Map([...global].map(([key, value]) => [key, jsonClone(value)]));
  const h = { global, durableGlobal, workspace, projects, slots, values, messages: [], errors: [], writes: [], attempts: [], beforeUpdate: undefined };
  h.configuration = section => ({ get: (name, fallback) => values[section === "agentHub" ? name : `${section?.replace(/^agentHub\./, "")}.${name}`] ?? fallback, update: async () => {} });
  current = h;
  // VS Code JSON-clones into its live cache synchronously, then awaits persistence.
  // A rejected update therefore leaves a different cached object unless the caller restores it.
  const memento = data => ({ keys: () => [...data.keys()], get: (key, fallback) => data.has(key) ? data.get(key) : fallback,
    update: async (key, value) => { const cached = jsonClone(value); data.set(key, cached); h.attempts.push({ key, value: jsonClone(cached) });
      await h.beforeUpdate?.(key, cached); h.writes.push(key); if (data === global) durableGlobal.set(key, jsonClone(cached)); } });
  const p = Object.create(ChatViewProvider.prototype);
  p.context = { globalState: memento(global), workspaceState: memento(workspace), secrets: { get: async () => undefined } };
  p.runs = new Map(); p.pendingPermissions = new Map(); p.deferred = new Map(); p.steers = new Map(); p.steerTexts = new Map(); p.sessionWriters = new Map();
  p.post = message => h.messages.push(message);
  p.multiPanel = { webview: { postMessage: message => h.messages.push(message) } };
  p.postSafety = () => {}; p.postSlashCommands = () => {}; p.postSettings = async () => {};
  p.listClaudeModels = () => []; p.listCodexModels = () => []; p.codexEffortLevels = () => null;
  h.p = p;
  h.send = (message, surface = "multi-panel") => p.onMessage(message, "vscode", undefined, surface);
  h.record = (id = "record-1", key = projects[0].id) => p.getProjectStore(key).sessions.find(entry => entry.id === id);
  h.request = (overrides = {}) => ({ type: "saveTaskState", chatId: slots[0].chatId, requestId: "task-save-1", identity: { projectKey: projects[0].id, recordId: "record-1", createdAt: 1 }, revision: h.record()?.task?.revision ?? 0, fields: fields(), ...overrides });
  h.taskMessages = () => h.messages.filter(m => m.type === "taskState");
  return h;
}

test("task notes round-trip across restart and provider switch without model calls", async () => {
  const h = setup(); h.p.runTurn = async () => assert.fail("notes must not call the model");
  await h.send(h.request());
  assert.deepEqual(h.record().task, { schemaVersion: 1, revision: 1, updatedAt: h.record().task?.updatedAt, ...fields() });
  assert.ok(Number.isSafeInteger(h.record().task.updatedAt));
  assert.equal(h.taskMessages().at(-1)?.revision, 1);
  await h.send({ type: "selectChatAgent", chatId: h.slots[0].chatId, agent: "codex" });
  assert.deepEqual(h.taskMessages().at(-1)?.task, h.record().task);
  const restored = setup({ global: new Map([[STORE, structuredClone(h.global.get(STORE))]]), workspace: h.workspace });
  await restored.send({ type: "ready", chatId: h.slots[0].chatId });
  const hydrated = restored.taskMessages().find(m => m.chatId === h.slots[0].chatId);
  assert.deepEqual(hydrated?.task, h.record().task);
  assert.deepEqual(hydrated?.identity, h.request().identity);
});

test("same-folder profiles and chats keep independent notes and no transcript replay on save", async () => {
  const h = setup();
  await h.send(h.request());
  assert.equal(h.record().task.revision, 1);
  assert.equal(h.record("record-2").task, undefined);
  assert.equal(h.record("other-record", h.projects[1].id).task, undefined);
  assert.equal(h.messages.some(m => m.type === "transcript" || m.type === "userMessage"), false);
  assert.equal(h.taskMessages().every(m => !m.chatId || m.chatId === h.slots[0].chatId), true);
});

test("stale revision, stale generation and mismatched bindings reject visibly without writes", async () => {
  const h = setup(); await h.send(h.request()); const before = structuredClone(h.record()); const writes = h.writes.length;
  const requests = [h.request({ revision: 0 }), h.request({ identity: { ...h.request().identity, createdAt: 2 } }),
    h.request({ identity: { ...h.request().identity, recordId: "record-2" } }), h.request({ identity: { ...h.request().identity, projectKey: h.projects[1].id } }),
    h.request({ chatId: "chat-deleted" })];
  for (const request of requests) {
    const count = h.taskMessages().length; await h.send(request);
    assert.ok(h.taskMessages().length > count && h.taskMessages().at(-1).error);
    assert.deepEqual(h.record(), before);
  }
  assert.equal(h.writes.length, writes);
});

test("failed persistence preserves the old notes and revision and never publishes success", async () => {
  const h = setup(); await h.send(h.request()); const before = structuredClone(h.record());
  h.messages.length = 0;
  h.beforeUpdate = async key => { if (key === STORE) throw new Error("storage offline"); };
  await h.send(h.request({ fields: fields({ outcome: "Unsaved" }) }));
  assert.deepEqual(h.record(), before);
  assert.ok(h.taskMessages().at(-1)?.error);
  assert.equal(h.taskMessages().at(-1)?.revision, 1);
  assert.equal(h.taskMessages().some(m => !m.error), false);
});

test("task-only sessions survive history pruning and new sessions start without notes", async () => {
  const h = setup(); await h.send(h.request()); await h.p.saveChatSlots([]);
  await h.p.newSession();
  assert.ok(h.record("record-1")?.task);
  const active = h.p.getActiveRecord(h.projects[0].id);
  assert.notEqual(active.id, "record-1"); assert.equal(active.task, undefined);
  assert.equal(h.taskMessages().at(-1)?.task, undefined);
});

test("empty cleared notes keep revision until a reused blank session gets a fresh generation", async () => {
  const h = setup(); await h.send(h.request());
  const empty = Object.fromEntries(Object.keys(fields()).map(key => [key, ""]));
  await h.send(h.request({ fields: empty }));
  assert.equal(h.record().task.revision, 2);
  await h.p.saveChatSlots([]);
  const old = h.request({ chatId: undefined, revision: 2 });
  await h.p.newSession();
  assert.equal(h.p.getActiveRecord(h.projects[0].id).id, old.identity.recordId);
  assert.equal(h.record().task, undefined);
  assert.ok(h.record().createdAt > old.identity.createdAt);
  await h.send(old, "view");
  assert.ok(h.taskMessages().at(-1).error); assert.equal(h.record().task, undefined);
});

test("a replaced or deleted record cannot be recreated by a delayed note save", async () => {
  const h = setup(); const stale = h.request();
  await h.send({ type: "newSession", chatId: h.slots[0].chatId });
  const currentSlot = h.p.findChatSlot(h.slots[0].chatId);
  const count = h.p.getProjectStore(h.projects[0].id).sessions.length;
  await h.send(stale);
  assert.ok(h.taskMessages().at(-1).error);
  assert.equal(h.record(currentSlot.recordId).task, undefined);
  assert.equal(h.p.getProjectStore(h.projects[0].id).sessions.length, count);
});

test("concurrent writers compare revisions after persistence and acknowledge only durable notes", async () => {
  const h = setup(), entered = gate(), release = gate(); let paused = false;
  h.beforeUpdate = async key => { if (key === STORE && !paused) { paused = true; entered.resolve(); await release.promise; } };
  const first = h.send(h.request({ requestId: "first" })); await entered.promise;
  assert.equal(h.record().task, undefined); assert.deepEqual(h.taskMessages(), []);
  const second = h.send(h.request({ requestId: "second", revision: 0, fields: fields({ outcome: "Stale second" }) }));
  release.resolve(); await Promise.all([first, second]);
  assert.equal(h.record().task.outcome, fields().outcome); assert.equal(h.record().task.revision, 1);
  assert.equal(h.taskMessages().find(m => m.requestId === "first").error, undefined);
  assert.ok(h.taskMessages().find(m => m.requestId === "second").error);
});

test("notes serialize with active turn writes without blocking the agent lifecycle or injecting prompts", async () => {
  const h = setup(); await mkdir(h.projects[0].path, { recursive: true });
  h.p.relocateAttachments = async (_cwd, attachments) => attachments;
  h.p.autoPull = async () => {}; h.p.buildProjectCard = async () => "";
  const started = gate(), release = gate(); const prompts = [];
  h.p.backends = { codex: { async *start(prompt) { prompts.push(prompt); started.resolve(); await release.promise; yield { kind: "contextUsage", usedTokens: 10, maxTokens: 100 }; yield { kind: "assistantText", text: "Reply" }; } } };
  const run = h.p.runTurn("Only this message", "codex", [], h.projects[0].id, true, undefined, h.slots[0].chatId);
  await started.promise;
  await h.send(h.request());
  assert.equal(h.record().task.revision, 1);
  assert.equal(h.p.runs.has(h.slots[0].chatId), true);
  assert.equal(prompts.length, 1); assert.equal(prompts[0].includes(fields().outcome), false);
  release.resolve(); await run;
  assert.equal(h.record().task.revision, 1); assert.equal(h.record().context.codex.used, 10);
  assert.equal(h.record().chatLog.at(-1).text, "Reply");
});

test("an agent event waiting behind task persistence reads the fresh record and keeps both changes", async () => {
  const h = setup(), entered = gate(), release = gate(); let paused = false;
  h.beforeUpdate = async key => { if (key === STORE && !paused) { paused = true; entered.resolve(); await release.promise; } };
  const saving = h.send(h.request()); await entered.promise;
  const event = h.p.mutateRecord(h.projects[0].id, "record-1", record => { record.context = { codex: { used: 42, max: 100 } }; });
  release.resolve(); await Promise.all([saving, event]);
  assert.equal(h.record().task.revision, 1); assert.equal(h.record().context.codex.used, 42);
});

test("malformed payloads cannot coerce, truncate or write task data", async () => {
  const h = setup(); const before = structuredClone(h.record());
  const invalid = [
    { fields: null }, { fields: [] }, { fields: { ...fields(), outcome: 1 } }, { fields: { ...fields(), unknown: true } },
    { fields: fields({ outcome: "x".repeat(2001) }) }, { fields: Object.fromEntries(Object.keys(fields()).map(key => [key, "x".repeat(2000)])) },
    { revision: "0" }, { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER }, { requestId: "" }, { requestId: "x".repeat(161) },
    { identity: null }, { identity: { ...h.request().identity, createdAt: "1" } }, { identity: { ...h.request().identity, extra: true } },
  ];
  for (const patch of invalid) {
    await h.send(h.request(patch)); assert.ok(h.taskMessages().at(-1).error); assert.deepEqual(h.record(), before);
  }
  assert.deepEqual(h.writes, []);
});

test("ordinary sidebar and editor save only their active logical conversation", async () => {
  const h = setup(); await h.send(h.request({ chatId: undefined }), "view");
  assert.equal(h.record().task.revision, 1);
  await h.send(h.request({ chatId: undefined, identity: { projectKey: h.projects[0].id, recordId: "record-2", createdAt: 2 } }), "panel");
  assert.ok(h.taskMessages().at(-1).error); assert.equal(h.record("record-2").task, undefined);
});

test("already-saved notes never alter a later model prompt or add an extra call", async () => {
  const h = setup(); await h.send(h.request()); await mkdir(h.projects[0].path, { recursive: true });
  h.p.relocateAttachments = async (_cwd, attachments) => attachments;
  h.p.autoPull = async () => {}; h.p.buildProjectCard = async () => "";
  const prompts = [];
  h.p.backends = { codex: { async *start(prompt) { prompts.push(prompt); yield { kind: "assistantText", text: "Reply" }; } } };
  await h.p.runTurn("Explicit user message", "codex", [], h.projects[0].id, true, undefined, h.slots[0].chatId);
  assert.equal(prompts.length, 1); assert.equal(prompts[0].includes(fields().outcome), false);
  assert.equal(prompts[0].includes("Explicit user message"), true);
  assert.equal(h.record().task.revision, 1);
});

test("queued transcript persistence cannot erase another record's final log or session ID", async () => {
  const h = setup(), entered = gate(), release = gate(); let paused = false;
  const key = h.projects[0].id;
  h.p.getProjectStore(key).sessions.push({ ...jsonClone(h.record("record-2")), id: "record-3", createdAt: 3 });
  h.beforeUpdate = async storageKey => { if (storageKey === STORE && !paused) { paused = true; entered.resolve(); await release.promise; } };
  const context = h.p.mutateRecord(key, "record-1", record => { record.context = { codex: { used: 11, max: 100 } }; });
  await entered.promise;
  const session = h.p.mutateRecord(key, "record-2", record => { record.agentIds.codex = "cli-session-2"; });
  const finalLog = h.p.mutateRecord(key, "record-3", record => { record.chatLog = [{ agent: "codex", role: "assistant", text: "Final answer survives" }]; });
  const transcript = h.send({ type: "saveTranscript", path: key, chatId: h.slots[0].chatId, recordId: "record-1", items: [{ role: "user", text: "New transcript" }] });
  await new Promise(resolve => setImmediate(resolve)); release.resolve(); await Promise.all([context, session, finalLog, transcript]);
  assert.equal(h.record("record-1").items[0].text, "New transcript");
  assert.equal(h.record("record-2").agentIds.codex, "cli-session-2");
  assert.equal(h.record("record-3").chatLog?.[0].text, "Final answer survives");
});

for (const action of ["newSession", "createChat", "applySession", "ensureActiveRecord"]) {
  test(`${action} reads the store after queued agent record writes`, async () => {
    const h = setup(), entered = gate(), release = gate(); let paused = false;
    const key = h.projects[0].id;
    h.p.getProjectStore(key).sessions.push({ ...jsonClone(h.record("record-2")), id: "record-3", createdAt: 3, items: [{ role: "user", text: "Keep history" }] });
    if (action === "ensureActiveRecord") h.p.getProjectStore(key).activeId = null;
    h.beforeUpdate = async storageKey => { if (storageKey === STORE && !paused) { paused = true; entered.resolve(); await release.promise; } };
    const context = h.p.mutateRecord(key, "record-1", record => { record.context = { codex: { used: 11, max: 100 } }; });
    await entered.promise;
    const session = h.p.mutateRecord(key, "record-2", record => { record.agentIds.codex = "queued-cli"; });
    const finalLog = h.p.mutateRecord(key, "record-3", record => { record.chatLog = [{ agent: "codex", role: "assistant", text: "Keep queued completion" }]; });
    const changing = action === "newSession" ? h.p.newSession(h.slots[0].chatId) : action === "createChat"
      ? h.send({ type: "createChat", projectPath: key }) : action === "applySession" ? h.p.applySession("record-2") : h.p.ensureActiveRecord(key);
    await new Promise(resolve => setImmediate(resolve)); release.resolve(); await Promise.all([context, session, finalLog, changing]);
    assert.equal(h.record("record-3").chatLog?.[0].text, "Keep queued completion");
  });
}

test("failed note persistence restores Memento's cloned cache through its update boundary", async () => {
  const h = setup(); await h.send(h.request()); const before = jsonClone(h.global.get(STORE)); let attempts = 0;
  h.beforeUpdate = async key => { if (key === STORE && ++attempts === 1) throw new Error("failed first persistence"); };
  await h.send(h.request({ fields: fields({ outcome: "This must not hydrate" }) }));
  assert.equal(attempts, 2, "rollback must call Memento.update, not mutate the submitted object");
  assert.deepEqual(h.global.get(STORE), before); assert.deepEqual(h.durableGlobal.get(STORE), before);
  h.messages.length = 0; await h.send({ type: "ready", chatId: h.slots[0].chatId });
  assert.equal(h.taskMessages().at(-1).task.outcome, fields().outcome); assert.equal(h.taskMessages().at(-1).revision, 1);
});

test("failed rollback retains committed reads, reports uncertainty and permits a later successful retry", async () => {
  const h = setup(); await h.send(h.request()); const before = jsonClone(h.global.get(STORE)); let attempted;
  h.beforeUpdate = async (key, value) => { if (key === STORE) { if (!attempted) attempted = jsonClone(value); throw new Error("disk unavailable"); } };
  await h.send(h.request({ fields: fields({ outcome: "Unconfirmed" }) }));
  // A late failed-write cache notification must not become the visible committed state.
  h.global.set(STORE, attempted);
  assert.deepEqual(h.p.getStoreAll(), before); assert.deepEqual(h.durableGlobal.get(STORE), before);
  h.messages.length = 0; await h.send({ type: "ready", chatId: h.slots[0].chatId });
  assert.equal(h.taskMessages().at(-1).revision, 1); assert.ok(h.taskMessages().at(-1).error);
  h.beforeUpdate = undefined;
  await h.send(h.request({ fields: fields({ outcome: "Retried successfully" }) }));
  assert.equal(h.record().task.revision, 2); assert.equal(h.record().task.outcome, "Retried successfully");
  assert.equal(h.taskMessages().at(-1).error, undefined);
  assert.equal(h.durableGlobal.get(STORE)[h.projects[0].id].sessions.find(record => record.id === "record-1").task.outcome, "Retried successfully");
});

test("unsupported task schemas survive pruning and new-session history limits without being overwritten", async () => {
  const h = setup(); const key = h.projects[0].id;
  const unknown = { schemaVersion: 99, revision: 4, payload: { outcome: "Future data must survive" } };
  h.record().task = jsonClone(unknown); await h.p.saveChatSlots([]);
  const store = h.p.getProjectStore(key); store.activeId = "record-2"; h.p.pruneEmptySessions(store, key);
  assert.deepEqual(store.sessions.find(record => record.id === "record-1")?.task, unknown);
  store.activeId = "record-1";
  store.sessions.push(...Array.from({ length: 35 }, (_, i) => ({ ...jsonClone(h.record("record-2")), id: `history-${i}`, createdAt: i + 20, updatedAt: i + 20, items: [{ role: "user", text: `History ${i}` }] })));
  await h.p.newSession();
  assert.notEqual(h.p.getActiveRecord(key).id, "record-1"); assert.deepEqual(h.record()?.task, unknown);
  const before = jsonClone(h.record());
  await h.p.saveChatSlots([h.slots[0]]);
  await h.send(h.request({ revision: 0 })); assert.ok(h.taskMessages().at(-1).error); assert.deepEqual(h.record(), before);
});

for (const selection of ["provider", "effort", "model"]) {
  test(`${selection} publishes the committed choice after waiting behind another project's write`, async () => {
    const h = setup(), entered = gate(), release = gate(); let paused = false;
    h.record().preferredAgent = "claude";
    h.beforeUpdate = async key => { if (key === STORE && !paused) { paused = true; entered.resolve(); await release.promise; } };
    const writing = h.p.mutateRecord(h.projects[1].id, "other-record", record => { record.context = { codex: { used: 7, max: 100 } }; });
    await entered.promise;
    const changing = selection === "provider" ? h.send({ type: "selectAgent", path: h.projects[0].id, agent: "codex" }, "view")
      : selection === "effort" ? h.p.applyEffort("codex", "high") : h.p.applyModel("codex", "chosen-model", false);
    await new Promise(resolve => setImmediate(resolve)); release.resolve(); await Promise.all([writing, changing]);
    if (selection === "provider") {
      assert.equal(h.record().preferredAgent, "codex");
      assert.equal(h.messages.filter(message => message.type === "agentInfo" && message.requestedAgent === "codex").at(-1)?.agent, "codex");
    } else if (selection === "effort") {
      assert.equal(h.record().effortOverrides.codex, "high");
      assert.equal(h.messages.filter(message => message.type === "effortInfo" && message.agent === "codex").at(-1)?.effort, "high");
      assert.equal(h.workspace.get("agentHub.lastAgentChoice").effortOverrides.codex, "high");
    } else {
      assert.equal(h.record().modelOverrides.codex, "chosen-model");
      assert.equal(h.messages.filter(message => message.type === "modelInfo" && message.agent === "codex" && !message.chatId).at(-1)?.model, "chosen-model");
      assert.equal(h.workspace.get("agentHub.lastAgentChoice").modelOverrides.codex, "chosen-model");
    }
  });
}

for (const surface of ["view", "panel"]) {
  test(`${surface} cannot address a board record by spoofing chatId`, async () => {
    const h = setup(); const before = jsonClone(h.global.get(STORE));
    await h.send(h.request({ chatId: h.slots[1].chatId, identity: { projectKey: h.projects[0].id, recordId: "record-2", createdAt: 2 } }), surface);
    assert.deepEqual(h.global.get(STORE), before); assert.deepEqual(h.writes, []);
    const ack = h.taskMessages().at(-1); assert.ok(ack?.error); assert.equal(ack.chatId, undefined);
  });
}

test("remote single-chat notes use the active conversation and reject board chatIds", async () => {
  const h = setup();
  await h.p.onMessage(h.request({ chatId: undefined }), "remote");
  assert.equal(h.record().task.revision, 1);
  const before = jsonClone(h.global.get(STORE));
  await h.p.onMessage(h.request({ chatId: h.slots[1].chatId, identity: { projectKey: h.projects[0].id, recordId: "record-2", createdAt: 2 }, revision: 0 }), "remote");
  assert.deepEqual(h.global.get(STORE), before); assert.ok(h.taskMessages().at(-1)?.error);
});
