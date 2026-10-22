import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-profiles-"));
const folder = join(temp, "shared");
const otherFolder = join(temp, "other");
await mkdir(folder); await mkdir(otherFolder);
const alias = join(temp, "alias"); await symlink(folder, alias);
const mockKey = Symbol.for("agent-hub-profile-tests");
let current;
globalThis[mockKey] = { get current() { return current; } };
after(async () => { delete globalThis[mockKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "profile-provider-dependencies", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$|^\.\/serverConnection$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-profile-tests")].current';
      if (path === "vscode") return { contents: `
        export const workspace={getConfiguration:(section)=>${h}.configuration(section),get workspaceFolders(){return ${h}.workspaceFolders},fs:{delete:async(uri)=>${h}.deleted.push(uri.fsPath)}};
        export const window={showOpenDialog:async()=>[{fsPath:${h}.pickedPath}],showWarningMessage:async(...args)=>${h}.warning?${h}.warning(...args):${h}.choices.shift(),showErrorMessage:async(m)=>${h}.errors.push(m),showInformationMessage:async()=>{},showQuickPick:async(items)=>${h}.pick?.(items),showInputBox:async()=>${h}.input};
        export const Uri={file:(fsPath)=>({fsPath})},commands={executeCommand:async(...args)=>${h}.commands.push(args)},ConfigurationTarget={Global:1},ViewColumn={},ProgressLocation={},env={};export class ThemeIcon{};` };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected process");};' };
      if (path === "./journal") return { contents: `export const readJournalContext=async(cwd)=>{${h}.journalDirs.push(cwd);return "";};export const buildFinishPrompt=()=>"finish";` };
      if (path === "./serverConnection") return { resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), contents: `export { formatSshCommand } from ${JSON.stringify(fileURLToPath(new URL("../src/serverConnection.ts", import.meta.url)))};export const buildServerEnvironment=(env,password)=>({...env,SSHPASS:password??env.SSHPASS??"",AGENT_HUB_SERVER_PASSWORD:password??env.SSHPASS??"",LFTP_PASSWORD:password??env.SSHPASS??""});export const testServerConnection=async(connection,password)=>{${h}.serverTests.push({connection,password});return {ok:true,message:"fixture"};};` };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{};export const enableTailscaleFunnel=()=>{};export const generateToken=()=>"";export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>"";export default{};' };
      return { contents: 'export class ClaudeBackend{};export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{};export const codexDefaultModel=()=>"test";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
const key = (p) => p.id ?? p.path;
function state(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, get: (k, fallback) => data.has(k) ? data.get(k) : fallback, update: async (k, value) => { if (value === undefined) data.delete(k); else data.set(k, value); } };
}
function setup(projects = [], workspaceFolders = []) {
  const h = { settings: { projects }, workspaceFolders, pickedPath: folder, choices: [], errors: [], deleted: [], commands: [], journalDirs: [], serverTests: [] };
  h.configuration = (section) => ({
    get: (k, fallback) => h.settings[section === "agentHub" ? k : `${section?.replace(/^agentHub\./, "")}.${k}`] ?? fallback,
    update: async (k, value) => { h.settings[section === "agentHub" ? k : `${section?.replace(/^agentHub\./, "")}.${k}`] = value; await h.onUpdate?.(k, value); },
  });
  current = h;
  const secrets = new Map();
  const p = Object.create(ChatViewProvider.prototype);
  p.context = { globalState: state(), workspaceState: state(), secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) } };
  p.runs = new Map(); p.steers = new Map(); p.steerTexts = new Map(); p.deferred = new Map(); p.pendingPermissions = new Map();
  p.directoryRuns = new Map(); p.sessionWriters = new Map();
  p.messages = []; p.post = (message) => p.messages.push(message);
  p.postSafety = () => {}; p.postEfforts = () => {}; p.postSlashCommands = () => {}; p.revealUi = () => {};
  p.autoPull = async (...args) => { h.pull = args; }; p.autoCommit = async (...args) => { h.commit = args; };
  p.buildAgentConfig = () => ({ contextWindow: 0 });
  return { h, p, secrets };
}
const a = { id: "project-alpha", path: folder, name: "A", serverHost: "a.example" };
const b = { id: "project-beta", path: folder, name: "B", serverHost: "b.example" };
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise((r) => setImmediate(r));

test("adding the same folder twice creates two fresh uniquely named profiles", async () => {
  const { p, secrets } = setup();
  await p.addProject(); await p.addProject();
  const projects = p.getProjects();
  assert.equal(projects.length, 2);
  assert.ok(projects.every((project) => /^project-/.test(project.id)));
  assert.notEqual(projects[0].id, projects[1].id);
  assert.notEqual(projects[0].name, projects[1].name);
  assert.equal(p.getActivePathRaw(), projects[1].id);
  assert.equal(secrets.size, 0);
  assert.equal(p.getProjectStore(projects[1].id).sessions.length, 0);
});

test("adding a workspace folder preserves its implicit legacy profile, history and secrets", async () => {
  const { h, p, secrets } = setup([], [{ name: "Legacy", uri: { fsPath: folder } }]);
  const legacy = await p.ensureActiveRecord(folder); legacy.items = [{ role: "user", text: "old" }];
  secrets.set(`agentHub.serverPassword:${folder}`, "legacy-fixture");
  await p.addProject();
  const projects = p.getProjects();
  assert.equal(projects.length, 2);
  assert.ok(h.settings.projects.some((project) => !project.id && project.path === folder));
  assert.strictEqual(p.getProjectStore(folder).sessions[0], legacy);
  const fresh = projects.find((project) => project.id);
  assert.ok(fresh);
  assert.equal(p.getProjectStore(fresh.id).sessions.length, 0);
  assert.equal(secrets.get(`agentHub.serverPassword:${fresh.id}`), undefined);
  assert.equal((await p.buildSettingsSnapshot()).projectHasPassword, false);
  assert.deepEqual(await p.getSecretEnv(fresh.id), {});
});

test("adding a previously hidden workspace folder creates only a fresh profile", async () => {
  const { p } = setup([], [{ name: "Hidden legacy", uri: { fsPath: folder } }]);
  await p.context.globalState.update("agentHub.hiddenProjects", [folder]);
  await p.addProject();
  const projects = p.getProjects();
  assert.equal(projects.length, 1);
  assert.ok(projects[0].id);
});

test("profile selection, settings and server passwords stay independent", async () => {
  const { h, p, secrets } = setup([a, b]);
  await p.onMessage({ type: "selectProject", path: b.id });
  assert.equal(p.getActiveProject().id, b.id);
  await p.applySettings({ project: { ...b, name: "B edited" }, newPassword: "fixture-b", claude: {}, codex: {} });
  await p.applySettings({ project: { ...a, name: "A edited" }, newPassword: "fixture-a", claude: {}, codex: {} });
  assert.equal(h.settings.projects.length, 2);
  assert.equal(h.settings.projects.find((project) => project.id === a.id).name, "A edited");
  assert.equal(secrets.get(`agentHub.serverPassword:${a.id}`), "fixture-a");
  assert.equal(secrets.get(`agentHub.serverPassword:${b.id}`), "fixture-b");
  await p.testServer({ type: "testServer", projectPath: b.id, requestId: "test-b", host: "b.example" });
  assert.equal(h.serverTests[0].password, "fixture-b");
  assert.equal(p.messages.at(-1).projectPath, b.id);
  const snapshot = await p.buildSettingsSnapshot();
  assert.equal(snapshot.project.id, b.id);
  assert.equal(snapshot.projectHasPassword, true);
});

test("sending env to a selected ID profile cannot write a sibling or the legacy path", async () => {
  const { h, p, secrets } = setup([{ path: folder, name: "Legacy" }, a, b]);
  secrets.set(`agentHub.secretEnv:${folder}`, JSON.stringify({ LEGACY: "fixture" }));
  secrets.set(`agentHub.secretEnv:${a.id}`, JSON.stringify({ A_ONLY: "fixture" }));
  h.pick = (items) => [items.find((item) => item.path === b.id)];
  await p.sendSecretEnvFromMessage("B_ONLY=fixture-b", a.id);
  assert.deepEqual(JSON.parse(secrets.get(`agentHub.secretEnv:${b.id}`)), { B_ONLY: "fixture-b" });
  assert.deepEqual(JSON.parse(secrets.get(`agentHub.secretEnv:${a.id}`)), { A_ONLY: "fixture" });
  assert.deepEqual(JSON.parse(secrets.get(`agentHub.secretEnv:${folder}`)), { LEGACY: "fixture" });
});

test("history, model overrides and transcripts are scoped by profile", async () => {
  const { p } = setup([a, b]);
  const first = await p.ensureActiveRecord(a.id);
  const second = await p.ensureActiveRecord(b.id);
  assert.notEqual(first.id, second.id);
  await p.setActivePath(a.id);
  await p.applyModel("codex", "model-a", false);
  await p.onMessage({ type: "saveTranscript", path: b.id, items: [{ role: "user", text: "B only" }] });
  assert.equal(first.modelOverrides.codex, "model-a");
  assert.equal(second.modelOverrides?.codex, undefined);
  assert.deepEqual(first.items, []);
  assert.equal(second.items[0].text, "B only");
  p.postFullState();
  assert.equal(p.messages.findLast((m) => m.type === "transcript").path, a.id);
});

test("removing one profile preserves its sibling and refuses shared-folder deletion", async () => {
  const { h, p } = setup([a, b]);
  h.choices = ["Удалить вместе с папкой"];
  await p.deleteProject(a.id);
  assert.equal(h.settings.projects.length, 2);
  assert.equal(h.deleted.length, 0);
  assert.ok(h.errors.length > 0);
  h.choices = ["Убрать из списка"];
  await p.deleteProject(a.id);
  assert.deepEqual(p.getProjects().map(key), [b.id]);
  assert.equal(h.deleted.length, 0);
});

test("folder deletion rechecks sibling profiles after final confirmation", async () => {
  const { h, p, secrets } = setup([a]);
  secrets.set(`agentHub.serverPassword:${a.id}`, "fixture-a");
  let confirmations = 0;
  h.warning = () => {
    if (++confirmations === 1) return "Удалить вместе с папкой";
    h.settings.projects.push(b);
    return "Да, удалить папку";
  };
  await p.deleteProject(a.id);
  assert.equal(h.settings.projects.length, 2);
  assert.equal(h.deleted.length, 0);
  assert.equal(secrets.get(`agentHub.serverPassword:${a.id}`), "fixture-a");
});

test("a sibling added during registry cleanup still prevents physical folder deletion", async () => {
  const { h, p } = setup([a]);
  h.choices = ["Удалить вместе с папкой", "Да, удалить папку"];
  h.onUpdate = (name, value) => {
    if (name === "projects" && !value.some((project) => project.id === a.id)) value.push(b);
  };
  await p.deleteProject(a.id);
  assert.deepEqual(h.settings.projects.map(key), [b.id]);
  assert.equal(h.deleted.length, 0);
  assert.ok(p.messages.some((m) => m.type === "info" && /папка сохранена/iu.test(m.text)));
});

test("legacy configured paths are normalized before identity comparison", async () => {
  const path = "~/agent-hub-fixture-project";
  const expanded = join(homedir(), "agent-hub-fixture-project");
  const { h, p } = setup([{ path, name: "Legacy" }]);
  await p.applySettings({ project: { path: expanded, name: "Changed" }, claude: {}, codex: {} });
  assert.equal(h.settings.projects.length, 1);
  assert.equal(p.getProjects()[0].name, "Changed");
});

test("normalization and import preserve valid IDs and merge by ID instead of folder", async () => {
  const { h, p } = setup([a, b]);
  const input = join(temp, "import.json");
  await writeFile(input, JSON.stringify({ projects: [{ ...b, name: "Imported B" }, { id: "project-gamma", path: folder, name: "C" }] }));
  h.pickedPath = input;
  await p.importSettings();
  assert.equal(h.settings.projects.length, 3);
  assert.equal(h.settings.projects.find((project) => project.id === b.id).name, "Imported B");
  await p.applyConfigJson(JSON.stringify({ projects: h.settings.projects }));
  assert.equal(p.getProjects().length, 3);
  assert.ok(p.collectAllSettings().projects.every((project) => project.id));
});

test("merging an imported profile preserves an existing implicit workspace profile", async () => {
  const { h, p, secrets } = setup([], [{ name: "Legacy", uri: { fsPath: folder } }]);
  const legacy = await p.ensureActiveRecord(folder);
  secrets.set(`agentHub.serverPassword:${folder}`, "legacy-fixture");
  const input = join(temp, "implicit-import.json");
  await writeFile(input, JSON.stringify({ projects: [b] }));
  h.pickedPath = input;
  await p.importSettings();
  assert.deepEqual(p.getProjects().map(key), [folder, b.id]);
  assert.strictEqual(p.getActiveRecord(folder), legacy);
  assert.equal(secrets.get(`agentHub.serverPassword:${b.id}`), undefined);
});

test("imported tilde paths preserve the expanded workspace's legacy profile", async () => {
  const { h, p } = setup([], [{ name: "Home legacy fixture", uri: { fsPath: homedir() } }]);
  const input = join(temp, "tilde-import.json");
  await writeFile(input, JSON.stringify({ projects: [{ id: "project-home-fixture", path: "~", name: "Home profile fixture" }] }));
  h.pickedPath = input;
  await p.importSettings();
  assert.deepEqual(p.getProjects().map(key), [homedir(), "project-home-fixture"]);
  assert.equal(p.getProjects()[1].path, homedir());
});

test("backend uses physical cwd while sessions, permissions and events use the profile ID", async () => {
  const { h, p, secrets } = setup([a, b]);
  secrets.set(`agentHub.serverPassword:${b.id}`, "fixture-b");
  const calls = [];
  p.backends = { codex: { async *start(prompt, opts) { calls.push({ prompt, opts }); yield { kind: "session", sessionId: "session-b" }; yield { kind: "assistantText", text: "B answer" }; yield { kind: "result", ok: true }; } } };
  await p.runTurn("B task", "codex", [], b.id, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.cwd, folder);
  assert.equal(calls[0].opts.extraEnv.SSHPASS, "fixture-b");
  assert.equal(p.getActiveRecord(b.id).agentIds.codex, "session-b");
  assert.equal(p.getActiveRecord(a.id), null);
  assert.ok(p.messages.filter((m) => ["busy", "sessionInfo", "assistantText"].includes(m.type)).every((m) => m.path === b.id));
  assert.deepEqual(h.pull, [folder, b.id, undefined]);
  assert.deepEqual(h.commit, [folder, "codex", "B task", b.id, undefined]);
  assert.deepEqual(h.journalDirs, [folder]);
});

test("same real folder permits independent sibling sessions and suppresses overlapping Git", async (t) => {
  const { p } = setup([a, { ...b, path: alias }]);
  const relocation = deferred();
  let relocations = 0;
  p.relocateAttachments = async (_path, files) => { relocations++; await relocation.promise; return files; };
  const calls = [];
  const pulls = []; const commits = [];
  p.autoPull = async (...args) => { pulls.push(args); };
  p.autoCommit = async (...args) => { commits.push(args); };
  p.backends = { codex: { async *start(_prompt, opts) { calls.push(opts.cwd); yield { kind: "result", ok: true }; } } };
  const first = p.runTurn("A task", "codex", [], a.id);
  const second = p.runTurn("B task", "codex", [], b.id);
  t.after(async () => { relocation.resolve(); await Promise.all([first, second]); });
  await tick();
  assert.equal(relocations, 2);
  assert.equal(p.runs.has(a.id), true);
  assert.equal(p.runs.has(b.id), true);
  relocation.resolve(); await Promise.all([first, second]);
  assert.deepEqual(calls, [folder, alias]);
  assert.deepEqual(pulls, []);
  assert.deepEqual(commits, []);
  assert.ok(p.messages.some((m) => m.path === b.id && m.type === "info" && /Git пропущено/.test(m.text)));
  await p.runTurn("B later", "codex", [], b.id);
  assert.equal(calls.length, 3);
  assert.equal(pulls.length, 1, "normal Git resumes after overlapping runs finish");
  assert.equal(commits.length, 1);
});

test("different physical folders can run concurrently and failed preparation releases ownership", async () => {
  const { p } = setup([a, { ...b, path: otherFolder }]);
  const gate = deferred(); let starts = 0;
  p.backends = { codex: { async *start() { starts++; await gate.promise; yield { kind: "result", ok: false }; } } };
  const first = p.runTurn("A", "codex", [], a.id);
  const second = p.runTurn("B", "codex", [], b.id);
  for (let i = 0; i < 20 && starts !== 2; i++) await tick();
  assert.equal(starts, 2);
  gate.resolve(); await Promise.all([first, second]);
  p.relocateAttachments = async () => { throw new Error("fixture preparation failed"); };
  await assert.rejects(p.runTurn("failed", "codex", [], a.id), /preparation failed/);
  assert.equal(p.runs.size, 0);
});

test("stopping an idle profile cannot abort a sibling profile's sole active run", async () => {
  const { p } = setup([a, b]);
  const sibling = new AbortController();
  p.runs.set(b.id, sibling);
  await p.onMessage({ type: "stop", path: a.id });
  assert.equal(sibling.signal.aborted, false);
  assert.equal(p.runs.get(b.id), sibling);
});

test("a question answered during final transcript persistence stays queued for its own profile", async (t) => {
  const { p } = setup([a, b]);
  const record = await p.ensureActiveRecord(a.id);
  record.agentIds.codex = "session-a";
  const backendDone = deferred(); const saving = deferred(); const releaseSave = deferred();
  const originalUpdate = p.context.globalState.update;
  let paused = false;
  p.context.globalState.update = async (name, value) => {
    if (name === "agentHub.sessionStore" && !paused && record.chatLog?.some((entry) => entry.text === "A task")) {
      paused = true; saving.resolve(); await releaseSave.promise;
    }
    await originalUpdate(name, value);
  };
  const starts = [];
  p.backends = { codex: { async *start(prompt, opts) {
    starts.push({ prompt, opts });
    if (starts.length === 1) {
      yield { kind: "question", id: "question-a", questions: [{ title: "Question?", options: [] }] };
      await backendDone.promise;
    }
    yield { kind: "result", ok: false };
  } } };
  const run = p.runTurn("A task", "codex", [], a.id, true);
  t.after(async () => { backendDone.resolve(); releaseSave.resolve(); await run; });
  for (let i = 0; i < 30 && p.pendingPermissions.size !== 1; i++) await tick();
  assert.equal(p.pendingPermissions.size, 1);
  const requestId = [...p.pendingPermissions.keys()][0];
  backendDone.resolve(); await saving.promise;
  await p.setActivePath(b.id);
  await p.onMessage({ type: "permission", requestId, allow: false, answer: "Answer A" });
  assert.equal(p.deferred.get(a.id)?.length, 1);
  releaseSave.resolve(); await run;
  assert.equal(starts.length, 2);
  assert.equal(starts[1].opts.cwd, folder);
  assert.match(starts[1].prompt, /Answer A/);
  assert.equal(p.getActiveRecord(b.id), null);
});

test("finishing a sibling profile cannot clear its sessions while the shared folder is busy", async (t) => {
  const { p } = setup([a, b]);
  const record = await p.ensureActiveRecord(b.id);
  record.agentIds.codex = "session-b";
  const gate = deferred(); let starts = 0;
  p.backends = { codex: { async *start() { starts++; await gate.promise; yield { kind: "result", ok: false }; } } };
  const first = p.runTurn("A task", "codex", [], a.id);
  t.after(async () => { gate.resolve(); await first; });
  for (let i = 0; i < 20 && starts !== 1; i++) await tick();
  assert.equal(starts, 1);
  await p.setActivePath(b.id);
  await p.finishSession("codex");
  assert.equal(record.agentIds.codex, "session-b");
  assert.equal(starts, 1);
  assert.equal(p.messages.some((m) => m.type === "info" && m.text.includes("Итоги записаны")), false);
});

test("relative file links and pasted attachments resolve through the profile physical path", async () => {
  const { h, p } = setup([a, b]);
  await writeFile(join(folder, "file.txt"), "fixture");
  await p.openFileFromChat("file.txt", b.id);
  assert.equal(h.commands[0][1].fsPath, join(folder, "file.txt"));
  await p.saveAttachment("same.txt", Buffer.from("fixture").toString("base64"), b.id);
  const message = p.messages.at(-1);
  assert.equal(message.type, "attachmentAdded");
  assert.equal(message.path, b.id);
  assert.ok(message.files[0].path.startsWith(join(folder, ".agent-hub", "attachments")));
  await p.saveAttachment("same.txt", Buffer.from("second").toString("base64"), a.id);
  assert.notEqual(p.messages.at(-1).files[0].path, message.files[0].path);
  assert.equal(p.messages.at(-1).path, a.id);
  const moved = await p.relocateAttachments(folder, message.files, a.id);
  assert.equal(moved[0].path, message.files[0].path);
});
