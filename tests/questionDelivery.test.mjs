import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";
const temp = await mkdtemp(join(tmpdir(), "agent-hub-question-delivery-"));
after(() => rm(temp, { recursive: true, force: true }));
const outfile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-provider", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      if (path === "vscode") return { contents: "export const workspace={getConfiguration:()=>({get:(_key,fallback)=>fallback,update:async()=>{}})}; export const Uri={},window={},commands={},ViewColumn={},ConfigurationTarget={},ProgressLocation={},env={}; export class ThemeIcon{};" };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected spawn")};' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>""; export const buildFinishPrompt=()=>"";' };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{}; export const enableTailscaleFunnel=()=>{}; export const generateToken=()=>""; export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>""; export default {};' };
      return { contents: 'export class ClaudeBackend{}; export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{}; export const codexDefaultModel=()=>"test";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function gate() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function until(check) { for (let i = 0; i < 50; i++) { if (check()) return; await tick(); } assert.fail("provider did not reach expected state"); }
function setup() {
  const p = Object.create(ChatViewProvider.prototype);
  const project = { path: temp, name: "Original" };
  const other = { path: join(temp, "other"), name: "Other" };
  const record = { id: "original-record", createdAt: 1, agentIds: { codex: "session-original", claude: null }, chatLog: [] };
  p.activeRecord = record;
  p.records = new Map([[record.id, record]]);
  p.getProjects = () => [project, other]; p.getActiveProject = () => project;
  p.getActiveRecord = () => p.activeRecord;
  p.ensureActiveRecord = async () => p.activeRecord;
  p.mutateRecord = async (_path, id, fn) => { const target = p.records.get(id); if (target) fn(target); };
  p.context = { secrets: { get: async () => undefined }, globalState: { update: async () => {} } };
  p.getSecretEnv = async () => ({}); p.buildProjectCard = async () => "";
  p.runs = new Map(); p.steers = new Map(); p.steerTexts = new Map(); p.deferred = new Map(); p.pendingPermissions = new Map();
  p.relocateAttachments = async (_cwd, attachments) => attachments;
  p.autoPull = async () => {}; p.autoCommit = async () => {}; p.buildAgentConfig = () => ({ contextWindow: 0 });
  p.revealUi = () => {}; p.notifyBackgroundPermission = () => {};
  p.messages = []; p.post = (message) => p.messages.push(message);
  return { p, project, other, record };
}
async function launch({ handler = async () => {}, rpc = false, noChannel = false, followUpEvents = [] } = {}) {
  const h = { ...setup(), starts: [], steered: [], done: gate() };
  h.p.backends = { codex: { async *start(prompt, opts) {
    h.starts.push({ prompt, opts });
    if (h.starts.length > 1) {
      for (const event of followUpEvents) yield event;
      yield { kind: "result", ok: false }; return;
    }
    if (!noChannel) opts.steer.handler = async (...args) => { h.steered.push(args); await handler(...args); };
    if (rpc) h.rpcAnswer = await opts.confirmTool("AskUserQuestion", { questions: [{ question: "Choose?", options: [{ label: "Да" }] }] });
    else yield { kind: "question", id: "same-call-id", questions: [{ title: "Choose?", options: [{ label: "Да" }] }] };
    await h.done.promise;
    opts.steer.handler = undefined;
    yield { kind: "result", ok: false };
  } } };
  h.run = h.p.runTurn("original task", "codex", [], temp);
  await until(() => h.p.pendingPermissions.size === 1);
  h.requestId = [...h.p.pendingPermissions.keys()][0];
  h.answer = (answer = "Да ✓") => h.p.onMessage({ type: "permission", requestId: h.requestId, allow: false, answer });
  return h;
}

test("async question answer reaches the active turn immediately and is not replayed at turn end", async () => {
  const h = await launch();
  await h.answer();
  assert.equal(h.steered.length, 1);
  assert.equal(h.steered[0][1], "next");
  assert.match(h.steered[0][0], /Да ✓/);
  assert.equal(h.p.deferred.get(temp)?.length ?? 0, 0);
  h.done.resolve(); await h.run;
  assert.equal(h.starts.length, 1);
  assert.equal(h.record.chatLog.filter((e) => e.role === "user" && e.text.includes("Да ✓")).length, 1);
});

test("duplicate answer clicks while the delivery acknowledgement is pending send only once", async () => {
  const ack = gate(); const h = await launch({ handler: () => ack.promise });
  const first = h.answer(); await tick();
  await h.answer();
  assert.equal(h.steered.length, 1);
  ack.resolve(); await first;
  h.done.resolve(); await h.run;
  assert.equal(h.starts.length, 1);
});

test("answer stays in its originating project even when another project is active", async () => {
  const h = await launch(); h.p.getActiveProject = () => h.other;
  await h.answer();
  assert.equal(h.steered.length, 1);
  assert.equal(h.p.messages.filter((m) => m.type === "userMessage").every((m) => m.path === temp), true);
  h.done.resolve(); await h.run;
});

test("a transport without a live channel queues one answer and sends it in one subsequent turn", async () => {
  const h = await launch({ noChannel: true }); await h.answer(); await h.answer();
  assert.equal(h.p.deferred.get(temp)?.length, 1);
  h.done.resolve(); await h.run;
  assert.equal(h.starts.length, 2);
  assert.match(h.starts[1].prompt, /Да ✓/);
});

test("a definitely ended channel falls back once, while an ambiguous delivery error never replays", async () => {
  for (const [message, shouldReplay] of [["ход уже завершён", true], ["connection lost after write", false]]) {
    const h = await launch({ handler: async () => { throw new Error(message); } });
    await h.answer();
    assert.equal(h.steered.length, 1);
    assert.equal(h.p.deferred.get(temp)?.length ?? 0, shouldReplay ? 1 : 0);
    h.done.resolve(); await h.run;
    assert.equal(h.starts.length, shouldReplay ? 2 : 1);
    if (!shouldReplay) assert.ok(h.p.messages.some((m) => m.type === "info" && /подтвержд|повтор/i.test(m.text)));
  }
});

test("RPC question resolves its request directly without steering or a follow-up prompt", async () => {
  const h = await launch({ rpc: true }); await h.answer(); await tick();
  assert.deepEqual(h.rpcAnswer, { allow: false, answer: "Да ✓" });
  assert.equal(h.steered.length, 0); assert.equal(h.p.deferred.size, 0);
  h.done.resolve(); await h.run; assert.equal(h.starts.length, 1);
});

test("a question from an old session cannot steer or queue a task into the replacement session", async () => {
  const h = await launch();
  h.p.activeRecord = { ...h.record, createdAt: 2, chatLog: [], agentIds: { ...h.record.agentIds, codex: "fresh-session" } };
  await h.answer();
  assert.equal(h.steered.length, 0); assert.equal(h.p.deferred.size, 0);
  h.done.resolve(); await h.run; assert.equal(h.starts.length, 1);
  assert.ok(h.p.messages.some((m) => m.type === "info" && /устарел|сессия/i.test(m.text)));
});

test("queued question answers are dropped if the original session is replaced before dequeue", async () => {
  const h = await launch({ noChannel: true }); await h.answer();
  h.p.activeRecord = { ...h.record, id: "new-record", createdAt: 2, agentIds: { codex: null, claude: null }, chatLog: [] };
  h.done.resolve(); await h.run;
  assert.equal(h.starts.length, 1);
});

test("late acknowledgement logs only to the originating record and never pollutes a new turn map", async () => {
  const ack = gate(); const h = await launch({ handler: () => ack.promise });
  const answer = h.answer(); await tick();
  assert.equal(h.steered.length, 1);
  h.done.resolve(); await h.run;
  const replacement = { ...h.record, id: "replacement", createdAt: 2, chatLog: [] };
  h.p.records.set(replacement.id, replacement); h.p.activeRecord = replacement;
  const freshTexts = ["fresh turn text"]; h.p.steerTexts.set(temp, freshTexts);
  ack.resolve(); await answer;
  assert.deepEqual(h.p.steerTexts.get(temp), freshTexts);
  assert.equal(replacement.chatLog.length, 0);
  assert.equal(h.record.chatLog.filter((e) => e.text.includes("Да ✓")).length, 1);
  assert.equal(h.starts.length, 1);
});

test("a completed run's old question never steers the unrelated currently active run", async () => {
  const h = await launch(); h.done.resolve(); await h.run;
  const foreign = [];
  h.p.runs.set(temp, new AbortController());
  h.p.steers.set(temp, { handler: async (...args) => foreign.push(args) });
  await h.answer();
  assert.deepEqual(foreign, []);
  assert.equal(h.p.deferred.get(temp)?.length, 1);
});


test("answer after original completion starts exactly one normal turn in the same session", async () => {
  const h = await launch(); h.done.resolve(); await h.run;
  await h.answer(); await h.answer();
  await until(() => h.starts.length === 2);
  assert.match(h.starts[1].prompt, /Да ✓/);
  assert.equal(h.starts[1].opts.resumeSessionId, "session-original");
  assert.equal(h.steered.length, 0);
});

test("empty answers and denied cards without an answer create no delivery", async () => {
  for (const answer of [undefined, "", "   "]) {
    const h = await launch();
    await h.p.onMessage({ type: "permission", requestId: h.requestId, allow: false, answer });
    h.done.resolve(); await h.run;
    assert.equal(h.steered.length, 0); assert.equal(h.starts.length, 1);
    assert.equal(h.p.deferred.size, 0);
  }
});

test("a removed originating project cannot receive an old answer", async () => {
  const h = await launch(); h.p.getProjects = () => [h.other];
  await h.answer(); h.done.resolve(); await h.run;
  assert.equal(h.steered.length, 0); assert.equal(h.starts.length, 1);
  assert.equal(h.p.deferred.size, 0);
});

test("queued answer never resumes an agent session that has since forked", async () => {
  const h = await launch({ noChannel: true }); await h.answer();
  h.record.agentIds.codex = "new-fork-session";
  h.done.resolve(); await h.run;
  assert.equal(h.starts.length, 1);
});

test("a late ACK after New Session cannot append a bubble or success info to its cleared transcript", async () => {
  const ack = gate(); const h = await launch({ handler: () => ack.promise });
  const answer = h.answer(); await until(() => h.steered.length === 1);
  h.done.resolve(); await h.run;
  const cleared = { ...h.record, createdAt: 2, chatLog: [], lastPrompts: {} };
  h.p.activeRecord = cleared; h.p.records.set(cleared.id, cleared);
  h.p.messages.length = 0;
  ack.resolve(); await answer;
  assert.equal(h.p.messages.some((m) => m.type === "userMessage" || (m.type === "info" && /Ответ передан/.test(m.text))), false);
  assert.deepEqual(cleared.chatLog, []);
  assert.deepEqual(cleared.lastPrompts, {});
});

for (const phase of ["relocateAttachments", "autoPull"]) {
  for (const queued of [false, true]) {
    test(`${queued ? "queued" : "late"} answer cannot cross New Session during ${phase}`, async () => {
      const h = await launch({ noChannel: true });
      const paused = gate(); const entered = gate();
      h.p[phase] = async () => { entered.resolve(); await paused.promise; return []; };
      if (queued) await h.answer();
      h.done.resolve();
      if (!queued) { await h.run; await h.answer(); }
      await entered.promise;
      const replacement = { ...h.record, id: "prep-replacement", createdAt: 2, chatLog: [], lastPrompts: {}, agentIds: { codex: "replacement-session", claude: null } };
      h.p.records.set(replacement.id, replacement); h.p.activeRecord = replacement;
      h.p.runs.get(temp)?.abort();
      h.p.messages.length = 0;
      paused.resolve();
      await h.run;
      for (let i = 0; i < 10; i++) await tick();
      assert.equal(h.starts.length, 1, "old answer must not start a backend in the new session");
      assert.deepEqual(replacement.chatLog, []);
      assert.deepEqual(replacement.lastPrompts, {});
      assert.equal(h.p.messages.some((m) => m.type === "userMessage" && m.text.includes("Да ✓")), false);
      assert.equal(h.p.runs.has(temp), false, "cancelled preparation must release its own reservation");
    });
  }
}


test("an authorized fallback's own session fork retains its answer and final context log", async () => {
  const h = await launch({ noChannel: true, followUpEvents: [
    { kind: "session", sessionId: "authorized-fork" },
    { kind: "contextUsage", usedTokens: 123, maxTokens: 4000 },
    { kind: "assistantText", text: "Answer processed" },
  ] });
  await h.answer(); h.done.resolve(); await h.run;
  assert.equal(h.starts.length, 2);
  assert.equal(h.record.agentIds.codex, "authorized-fork");
  assert.deepEqual(h.record.context.codex, { used: 123, max: 4000 });
  assert.equal(h.record.chatLog.filter((e) => e.role === "user" && e.text.includes("Да ✓")).length, 1);
  assert.equal(h.record.chatLog.filter((e) => e.role === "assistant" && e.text === "Answer processed").length, 1);
});
