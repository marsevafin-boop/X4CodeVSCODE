import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-profile-questions-"));
after(() => rm(temp, { recursive: true, force: true }));
const outfile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-profile-questions", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      if (path === "vscode") return { contents: "export const workspace={getConfiguration:()=>({get:(_key,fallback)=>fallback,update:async()=>{}})}; export const Uri={},window={},commands={},ViewColumn={},ConfigurationTarget={},ProgressLocation={},env={}; export class ThemeIcon{};" };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected external process")};' };
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
async function until(check) {
  for (let i = 0; i < 50; i++) { if (check()) return; await tick(); }
  assert.fail("profile question did not reach expected state");
}

async function launch(t, { noChannel = false, acknowledgement } = {}) {
  const p = Object.create(ChatViewProvider.prototype);
  const one = { id: "project-one", path: temp, name: "One" };
  const two = { id: "project-two", path: temp, name: "Two" };
  const makeRecord = (id, session) => ({
    id, createdAt: 1, agentIds: { codex: session, claude: null }, chatLog: [],
  });
  const recordOne = makeRecord("one-record", "one-codex-session");
  const recordTwo = makeRecord("two-record", "two-codex-session");
  const records = new Map([[one.id, recordOne], [two.id, recordTwo]]);
  p.selected = one;
  p.getProjects = () => [one, two]; p.getActiveProject = () => p.selected;
  p.getActiveRecord = (key) => records.get(key) ?? null;
  p.ensureActiveRecord = async (key) => {
    assert.ok(records.has(key), "session store must use the logical profile ID");
    return records.get(key);
  };
  p.mutateRecord = async (key, id, fn) => {
    const record = records.get(key);
    if (record?.id === id) fn(record);
  };
  const state = new Map();
  p.context = { secrets: { get: async () => undefined }, globalState: {
    get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
    update: async (key, value) => state.set(key, value),
  } };
  p.getSecretEnv = async () => ({});
  p.buildProjectCard = async (project) => `Profile: ${project.id}`;
  p.runs = new Map(); p.steers = new Map(); p.steerTexts = new Map(); p.deferred = new Map(); p.pendingPermissions = new Map();
  p.directoryRuns = new Map(); p.sessionWriters = new Map();
  p.relocateAttachments = async (_cwd, attachments) => attachments;
  p.autoPull = async () => {}; p.autoCommit = async () => {}; p.buildAgentConfig = () => ({ contextWindow: 0 });
  p.revealUi = () => {}; p.notifyBackgroundPermission = () => {};
  const messages = []; p.post = (message) => messages.push(message);
  const done = gate(); const starts = []; const steered = [];
  p.backends = { codex: { async *start(prompt, options) {
    starts.push({ prompt, options });
    if (starts.length > 1) { yield { kind: "result", ok: false }; return; }
    if (!noChannel) options.steer.handler = async (text, mode) => {
      steered.push({ text, mode });
      if (acknowledgement) await acknowledgement.promise;
    };
    yield { kind: "question", id: "shared-call", questions: [{ title: "Profile choice?", options: [{ label: "Use profile one" }] }] };
    await done.promise;
    options.steer.handler = undefined;
    yield { kind: "result", ok: false };
  } } };
  const h = { p, one, two, records, recordOne, recordTwo, messages, starts, steered, done };
  h.run = p.runTurn("Profile one task", "codex", [], one.id);
  h.run.then(() => { h.finished = true; }, (error) => { h.error = error; h.finished = true; });
  t.after(async () => { acknowledgement?.resolve(); done.resolve(); await h.run; });
  await until(() => p.pendingPermissions.size > 0 || h.finished);
  if (h.error) throw h.error;
  assert.equal(starts.length, 1, "logical profile ID must select its backend run");
  assert.equal(starts[0].options.cwd, temp, "backend must receive the actual shared folder");
  assert.equal(starts[0].options.resumeSessionId, "one-codex-session");
  assert.equal(p.pendingPermissions.size, 1);
  h.requestId = [...p.pendingPermissions.keys()][0];
  h.answer = () => p.onMessage({ type: "permission", requestId: h.requestId, allow: false, answer: "Only profile one ✓" });
  return h;
}

test("profile One question steers its own active run while same-folder profile Two is selected", async (t) => {
  const h = await launch(t);
  h.p.selected = h.two;
  await h.answer();
  assert.equal(h.steered.length, 1);
  assert.equal(h.steered[0].mode, "next");
  assert.match(h.steered[0].text, /Only profile one/);
  assert.equal(h.p.deferred.get(h.one.id)?.length ?? 0, 0);
  assert.ok(h.messages.some((m) => m.type === "userMessage" && m.path === h.one.id));
  assert.equal(h.messages.some((m) => m.type === "userMessage" && m.path === h.two.id), false);
  h.done.resolve(); await h.run;
  assert.equal(h.starts.length, 1, "accepted answer must not be replayed after the turn");
  assert.equal(h.recordOne.chatLog.filter((e) => e.text.includes("Only profile one")).length, 1);
  assert.deepEqual(h.recordTwo.chatLog, []);
});

test("duplicate clicks on a profile-bound answer deliver once without a follow-up run", async (t) => {
  const acknowledgement = gate(); const h = await launch(t, { acknowledgement });
  h.p.selected = h.two;
  const first = h.answer(); await tick(); await h.answer();
  assert.equal(h.steered.length, 1);
  acknowledgement.resolve(); await first;
  h.done.resolve(); await h.run;
  assert.equal(h.starts.length, 1);
  assert.equal(h.recordOne.chatLog.filter((e) => e.text.includes("Only profile one")).length, 1);
  assert.deepEqual(h.recordTwo.chatLog, []);
});

test("stale profile One question cannot enter selected same-folder profile Two", async (t) => {
  const h = await launch(t);
  h.p.selected = h.two;
  h.records.set(h.one.id, { ...h.recordOne, createdAt: 2, agentIds: { codex: "replacement-one", claude: null }, chatLog: [] });
  await h.answer();
  assert.deepEqual(h.steered, []);
  assert.equal(h.p.deferred.size, 0);
  h.done.resolve(); await h.run;
  assert.equal(h.starts.length, 1);
  assert.deepEqual(h.recordTwo.chatLog, []);
  assert.equal(h.messages.some((m) => m.type === "userMessage" && m.text.includes("Only profile one")), false);
});

test("deferred profile One answer resumes profile One with the real folder while Two is selected", async (t) => {
  const h = await launch(t, { noChannel: true });
  h.p.selected = h.two;
  await h.answer(); await h.answer();
  assert.equal(h.p.deferred.get(h.one.id)?.length, 1);
  assert.equal(h.p.deferred.has(h.two.id), false);
  assert.equal(h.p.deferred.has(temp), false);
  h.done.resolve(); await h.run;
  assert.equal(h.starts.length, 2);
  assert.equal(h.starts[1].options.cwd, temp);
  assert.equal(h.starts[1].options.resumeSessionId, "one-codex-session");
  assert.match(h.starts[1].prompt, /Profile: project-one/);
  assert.match(h.starts[1].prompt, /Only profile one/);
  assert.equal(h.recordOne.chatLog.filter((e) => e.text.includes("Only profile one")).length, 1);
  assert.deepEqual(h.recordTwo.chatLog, []);
  assert.equal(h.messages.some((m) => m.type === "userMessage" && m.path === h.two.id), false);
});

test("late profile One answer starts its own session after selection changes to same-folder Two", async (t) => {
  const h = await launch(t);
  h.done.resolve(); await h.run;
  h.p.selected = h.two;
  await h.answer(); await h.answer();
  await until(() => h.starts.length === 2);
  await until(() => !h.p.runs.has(h.one.id));
  assert.equal(h.starts[1].options.cwd, temp);
  assert.equal(h.starts[1].options.resumeSessionId, "one-codex-session");
  assert.equal(h.steered.length, 0);
  assert.deepEqual(h.recordTwo.chatLog, []);
  assert.equal(h.messages.some((m) => m.type === "userMessage" && m.path === h.two.id), false);
});
