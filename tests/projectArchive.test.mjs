import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, lstat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-archive-"));
const mockKey = Symbol.for("agent-hub-archive-tests");
let current;
globalThis[mockKey] = { get current() { return current; } };
after(async () => { delete globalThis[mockKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))], outfile,
  bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "archive-dependencies", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$|^\.\/serverConnection$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-archive-tests")].current';
      if (path === "vscode") return { contents: `
        export const workspace={getConfiguration:(s)=>${h}.configuration(s),get workspaceFolders(){return ${h}.workspaceFolders},fs:{rename:async(a,b,o)=>${h}.rename(a.fsPath,b.fsPath,o)}};
        export const window={showWarningMessage:async(...args)=>${h}.warning(...args),showErrorMessage:async(m)=>${h}.errors.push(m),showInformationMessage:async(m)=>${h}.infos.push(m),showQuickPick:async(items)=>${h}.pick?.(items),showInputBox:async()=>${h}.input?.(),showOpenDialog:async()=>${h}.open?${h}.open():[{fsPath:${h}.pickedPath}],showSaveDialog:async()=>({fsPath:${h}.exportPath})};
        export const Uri={file:(fsPath)=>({fsPath})},commands={executeCommand:async()=>{}},ConfigurationTarget={Global:1},ViewColumn={},ProgressLocation={},env={};export class ThemeIcon{};` };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected process");};' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>"";export const buildFinishPrompt=()=>"finish";' };
      if (path === "./serverConnection") return { contents: 'export const buildServerEnvironment=(e)=>e;export const formatSshCommand=()=>"ssh";export const testServerConnection=async()=>({ok:true});' };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{};export const enableTailscaleFunnel=()=>{};export const generateToken=()=>"";export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>"";export default{};' };
      return { contents: 'export class ClaudeBackend{};export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{};export const codexDefaultModel=()=>"test";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
function state(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, keys: () => [...data.keys()], get: (k, fallback) => data.has(k) ? data.get(k) : fallback, update: async (k, value) => { if (value === undefined) data.delete(k); else data.set(k, value); } };
}
async function setup({ profiles = 1, workspace = false } = {}) {
  const parent = await mkdtemp(join(temp, "fixture-"));
  const folder = join(parent, "Проект 🚀");
  await mkdir(join(folder, ".git"), { recursive: true });
  await writeFile(join(folder, ".git", "config"), "git fixture");
  await writeFile(join(folder, ".env"), "FIXTURE_SECRET=retain");
  await writeFile(join(folder, "file.txt"), "content");
  const projects = Array.from({ length: profiles }, (_, i) => ({ id: `project-copy${i}`, path: folder, name: `Profile ${i}`, serverHost: "fixture.example" }));
  const h = { settings: { projects }, workspaceFolders: workspace ? [{ name: "Workspace", uri: { fsPath: folder } }] : [], errors: [], infos: [], prompts: [], moves: [] };
  h.warning = async (...args) => { h.prompts.push(args); return args.at(-1); };
  h.configuration = (section) => ({
    get: (k, fallback) => h.settings[section === "agentHub" ? k : `${section?.replace(/^agentHub\./, "")}.${k}`] ?? fallback,
    update: async (k, value) => { await h.beforeUpdate?.(k, value); h.settings[k] = value; },
  });
  h.rename = async (a, b, options) => { assert.equal(options.overwrite, false); await h.beforeMove?.(a, b); try { await lstat(b); throw new Error("target exists"); } catch (e) { if (e.code !== "ENOENT") throw e; } h.moves.push([a, b]); await rename(a, b); };
  current = h;
  const secrets = new Map([[`agentHub.serverPassword:${projects[0]?.id}`, "fixture-password"]]);
  const p = Object.create(ChatViewProvider.prototype);
  p.context = { globalState: state(), workspaceState: state(), secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) } };
  p.runs = new Map(); p.steers = new Map(); p.steerTexts = new Map(); p.deferred = new Map(); p.pendingPermissions = new Map(); p.directoryRuns = new Map(); p.sessionWriters = new Map();
  p.messages = []; p.post = (m) => p.messages.push(m); p.postRuntimeSettings = () => {}; p.postSettings = async () => {}; p.revealUi = () => {};
  return { p, h, folder, parent, projects, secrets };
}
const missing = async (path) => { await assert.rejects(lstat(path), { code: "ENOENT" }); };

test("archive moves all files, hides profiles and retains IDs, secrets, history and chat slots; restore keeps selection", async () => {
  const { p, h, folder, projects, secrets } = await setup({ profiles: 2 });
  const rec = await p.ensureActiveRecord(projects[0].id); rec.items = [{ role: "user", text: "history" }];
  const slots = [{ chatId: "chat-12345678", projectPath: projects[0].id, recordId: rec.id, agent: "codex" }];
  await p.saveChatSlots(slots); await p.setActivePath(projects[0].id);
  await p.archiveProject(projects[0].id);
  assert.equal(p.getProjects().length, 0);
  const archived = p.getArchivedProjects(); assert.equal(archived.length, 2);
  assert.equal(archived[0].path, folder); assert.equal(archived[0].id, projects[0].id);
  assert.equal(archived[0].archive.path, join(h.moves[0][1]));
  await missing(folder);
  assert.equal(await readFile(join(archived[0].archive.path, ".env"), "utf8"), "FIXTURE_SECRET=retain");
  assert.equal(await readFile(join(archived[0].archive.path, ".git", "config"), "utf8"), "git fixture");
  assert.equal(secrets.get(`agentHub.serverPassword:${projects[0].id}`), "fixture-password");
  assert.deepEqual(p.getProjectStore(projects[0].id).sessions[0].items, rec.items);
  assert.deepEqual(p.getChatSlots(), slots);
  assert.ok(h.prompts[0][1].detail.includes("Profile 0") && h.prompts[0][1].detail.includes("Profile 1"));
  const selection = p.getActivePathRaw();
  await p.restoreProject(projects[1].id);
  assert.equal(p.getProjects().length, 2); assert.equal(p.getArchivedProjects().length, 0);
  assert.equal(p.getActivePathRaw(), selection); assert.equal(await readFile(join(folder, "file.txt"), "utf8"), "content");
});

test("archive chooses an unoccupied sibling Archive name without replacing anything", async () => {
  const { p, folder, parent, projects } = await setup();
  await mkdir(join(parent, "Archive", "Проект 🚀"), { recursive: true });
  await writeFile(join(parent, "Archive", "Проект 🚀", "keep"), "untouched");
  await p.archiveProject(projects[0].id);
  assert.equal(p.getArchivedProjects()[0].archive.path, join(parent, "Archive", "Проект 🚀 (2)"));
  assert.equal(await readFile(join(parent, "Archive", "Проект 🚀", "keep"), "utf8"), "untouched");
  await missing(folder);
});

test("restore refuses occupied original path, including dangling symlink", async () => {
  const { p, folder, projects } = await setup();
  await p.archiveProject(projects[0].id);
  await symlink(join(folder, "missing"), folder);
  await p.restoreProject(projects[0].id);
  assert.equal(p.getArchivedProjects().length, 1); assert.equal((await lstat(folder)).isSymbolicLink(), true);
  assert.match(p.messages.filter((m) => m.type === "error").at(-1)?.message ?? current.errors.at(-1), /занят|существует/);
});

test("active runs, including nested cwd and tile runs, refuse moving without aborting", async () => {
  const { p, h, folder, projects } = await setup();
  const controller = new AbortController();
  p.directoryRuns.set(join(folder, "nested"), { controllers: new Set([controller]), overlapped: false });
  await p.archiveProject(projects[0].id);
  assert.equal(h.moves.length, 0); assert.equal(controller.signal.aborted, false); assert.equal(p.getProjects().length, 1);
});

test("run admitted during archive confirmation blocks the move on recheck", async () => {
  const { p, h, folder, projects } = await setup();
  const controller = new AbortController();
  h.warning = async (...args) => { p.directoryRuns.set(folder, { controllers: new Set([controller]), overlapped: false }); return args.at(-1); };
  await p.archiveProject(projects[0].id);
  assert.equal(h.moves.length, 0); assert.equal(controller.signal.aborted, false);
});

test("nested registered folders and currently open workspace cannot be moved", async () => {
  const { p, h, folder, projects } = await setup();
  h.settings.projects.push({ id: "project-nested", name: "nested", path: join(folder, "child") });
  await p.archiveProject(projects[0].id); assert.equal(h.moves.length, 0);
  h.settings.projects.pop(); h.workspaceFolders = [{ name: "open", uri: { fsPath: folder } }];
  await p.archiveProject(projects[0].id); assert.equal(h.moves.length, 0);
});

test("archive container and source symlinks are rejected; file containers do not overwrite", async () => {
  for (const kind of ["archive-link", "source-link", "archive-file"]) {
    const { p, h, folder, parent, projects } = await setup();
    if (kind === "archive-link") await symlink(folder, join(parent, "Archive"));
    if (kind === "archive-file") await writeFile(join(parent, "Archive"), "keep");
    if (kind === "source-link") { const alias = join(parent, "alias"); await symlink(folder, alias); h.settings.projects[0].path = alias; }
    await p.archiveProject(projects[0].id); assert.equal(h.moves.length, 0, kind); assert.equal(p.getProjects().length, 1);
  }
});

test("failed registry save rolls folder back and retains active project", async () => {
  const { p, h, folder, projects } = await setup();
  h.beforeUpdate = async (key, value) => { if (key === "projects" && value.some((v) => v.archive)) throw new Error("settings read-only"); };
  await p.archiveProject(projects[0].id);
  assert.equal(p.getProjects().length, 1); assert.equal(await readFile(join(folder, "file.txt"), "utf8"), "content");
  assert.equal(h.moves.length, 2);
});

test("cancelled archive never renames", async () => {
  const { p, h, projects } = await setup(); h.warning = async () => undefined;
  await p.archiveProject(projects[0].id); assert.equal(h.moves.length, 0);
});

test("archived legacy workspace paths stay hidden and archived tile bindings remain", async () => {
  const { p, h, folder } = await setup({ profiles: 0 });
  h.settings.projects = [{ name: "legacy", path: folder, archive: { path: join(current.settings.projects[0]?.path ?? folder, "..", "Archive", "Проект 🚀"), archivedAt: 123 } }];
  h.workspaceFolders = [{ name: "original", uri: { fsPath: folder } }, { name: "moved", uri: { fsPath: join(folder, "..", "Archive", "Проект 🚀") } }];
  assert.equal(p.getProjects().length, 0); assert.equal(p.getAllProjects().length, 1);
});

test("settings export/config import keep archive metadata, ignore malformed locations", async () => {
  const { p, h, folder, parent, projects } = await setup(); await p.archiveProject(projects[0].id);
  const archived = p.getArchivedProjects()[0];
  assert.deepEqual(p.collectAllSettings().projects[0].archive, archived.archive);
  await p.applyConfigJson(JSON.stringify({ projects: [archived] }));
  assert.deepEqual(h.settings.projects[0].archive, archived.archive); assert.equal(p.getProjects().length, 0);
  await p.applyConfigJson(JSON.stringify({ projects: [{ ...projects[0], id: "project-malformed", path: join(parent, "malformed"), archive: { path: join(parent, "outside"), archivedAt: 1 } }] }));
  assert.equal(h.settings.projects[0].archive, undefined);
});

test("archived projects cannot be run or hydrated as active chat tiles", async () => {
  const { p, h, projects } = await setup();
  const rec = await p.ensureActiveRecord(projects[0].id);
  const slot = { chatId: "chat-12345678", projectPath: projects[0].id, recordId: rec.id, agent: "codex" };
  await p.saveChatSlots([slot]); await p.archiveProject(projects[0].id);
  const events = []; p.multiPanel = { webview: { postMessage: (m) => events.push(m) } };
  await p.postMultiState();
  const board = events.find((m) => m.type === "multiState"); assert.deepEqual(board.chats.map((s) => s.chatId), [slot.chatId]);
  assert.equal(board.archivedProjects.length, 1); assert.equal(events.some((m) => m.type === "transcript"), false);
  await p.runTurn("must not run", "codex", [], slot.projectPath, false, undefined, slot.chatId);
  assert.equal(p.runs.size, 0); assert.equal(h.moves.length, 1);
});

test("cross-filesystem rename failure keeps source and registry, never falls back to copy/delete", async () => {
  const { p, h, folder, parent, projects } = await setup();
  h.beforeMove = async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); };
  await p.archiveProject(projects[0].id);
  assert.equal(p.getProjects().length, 1); assert.equal(await readFile(join(folder, ".env"), "utf8"), "FIXTURE_SECRET=retain");
  assert.deepEqual(await readdir(join(parent, "Archive")), []);
  assert.equal(p.context.globalState.get("agentHub.pendingProjectMove"), undefined);
});

test("a rollback failure reports exact recovery paths and the journal recovers moved files", async () => {
  const { p, h, folder, projects } = await setup(); let moves = 0;
  h.beforeUpdate = async (key) => { if (key === "projects") throw new Error("read-only settings"); };
  h.beforeMove = async () => { if (++moves === 2) throw new Error("rollback blocked"); };
  await p.archiveProject(projects[0].id);
  const pending = p.context.globalState.get("agentHub.pendingProjectMove"); assert.ok(pending);
  assert.ok(h.errors.at(-1).includes(pending.plan.destination) && h.errors.at(-1).includes(folder));
  assert.equal(await readFile(join(pending.plan.destination, "file.txt"), "utf8"), "content");
  h.beforeUpdate = undefined; h.beforeMove = undefined;
  await p.recoverPendingProjectMove();
  assert.equal(p.getProjects().length, 0); assert.equal(p.getArchivedProjects()[0].archive.path, pending.plan.destination);
  assert.equal(p.context.globalState.get("agentHub.pendingProjectMove"), undefined);
});

test("stale active project settings cannot unarchive an already moved directory", async () => {
  const { p, h, folder, projects } = await setup(); await p.archiveProject(projects[0].id);
  const archive = p.getArchivedProjects()[0].archive;
  await p.applySettings({ project: { ...projects[0], name: "Edited", path: join(folder, "changed") }, claude: {}, codex: {} });
  assert.deepEqual(h.settings.projects[0].archive, archive); assert.equal(h.settings.projects[0].path, folder);
  assert.equal(p.getProjects().length, 0);
});

test("settings JSON import and export retain archived metadata without moving folders", async () => {
  const { p, h, parent, projects } = await setup(); await p.archiveProject(projects[0].id);
  h.exportPath = join(parent, "settings.json"); await p.exportSettings();
  const payload = JSON.parse(await readFile(h.exportPath, "utf8"));
  assert.equal(payload.settings.projects[0].archive.path, p.getArchivedProjects()[0].archive.path);
  h.pickedPath = h.exportPath; await p.importSettings();
  assert.equal(p.getProjects().length, 0); assert.equal(p.getArchivedProjects().length, 1); assert.equal(h.moves.length, 1);
});

test("archive preserves saved project order across arrow moves, reorder and restore", async () => {
  const { p, h, parent, projects } = await setup();
  const second = { id: "project-second", name: "Second", path: join(parent, "Second") };
  const third = { id: "project-third", name: "Third", path: join(parent, "Third") };
  await mkdir(second.path); await mkdir(third.path); h.settings.projects.push(second, third);
  await p.onMessage({ type: "reorderProjects", paths: [third.id, projects[0].id, second.id] });
  assert.deepEqual(p.getProjects().map((v) => v.id), [third.id, projects[0].id, second.id]);
  await p.archiveProject(projects[0].id);
  await p.onMessage({ type: "moveProject", path: second.id, direction: "up" });
  assert.deepEqual(p.getProjects().map((v) => v.id), [second.id, third.id]);
  await p.restoreProject(projects[0].id);
  assert.deepEqual(p.getProjects().map((v) => v.id), [second.id, projects[0].id, third.id]);
  await p.onMessage({ type: "reorderProjects", paths: [second.id, second.id, third.id] });
  assert.deepEqual(p.getProjects().map((v) => v.id), [second.id, projects[0].id, third.id]);
});

test("registered Archive container prevents moving another project into its files", async () => {
  const { p, h, parent, projects } = await setup();
  await mkdir(join(parent, "Archive"));
  h.settings.projects.push({ id: "project-container", name: "Archive project", path: join(parent, "Archive") });
  await p.archiveProject(projects[0].id); assert.equal(h.moves.length, 0);
});

test("unresolved interrupted move blocks new runs until the journal is recovered", async () => {
  const { p, projects } = await setup();
  await p.context.globalState.update("agentHub.pendingProjectMove", { plan: {}, keys: [], nextProjects: [] });
  p.autoPull = async () => {}; p.autoCommit = async () => {};
  let starts = 0; p.backends = { codex: { async *start() { starts++; yield { kind: "result", ok: false }; } } };
  await p.runTurn("must wait for recovery", "codex", [], projects[0].id);
  assert.equal(starts, 0); assert.equal(p.runs.size, 0);
});

test("stale JSON and imported active profiles cannot discard archive location or revive files", async () => {
  const { p, h, parent, projects } = await setup(); await p.archiveProject(projects[0].id);
  const archived = p.getArchivedProjects()[0];
  await p.applyConfigJson(JSON.stringify({ projects: [{ ...projects[0], name: "stale form" }] }));
  assert.deepEqual(p.getArchivedProjects()[0]?.archive, archived.archive); assert.equal(p.getProjects().length, 0);
  h.pickedPath = join(parent, "old-export.json"); await writeFile(h.pickedPath, JSON.stringify({ projects }));
  await p.importSettings(); assert.deepEqual(p.getArchivedProjects()[0]?.archive, archived.archive);
  assert.equal(h.moves.length, 1);
});

test("pending move rejection is delivered to its multichat tile", async () => {
  const { p, projects } = await setup(); const rec = await p.ensureActiveRecord(projects[0].id);
  const slot = { chatId: "chat-12345678", projectPath: projects[0].id, recordId: rec.id, agent: "codex" };
  await p.saveChatSlots([slot]); const messages = []; p.multiPanel = { webview: { postMessage: (m) => messages.push(m) } };
  await p.context.globalState.update("agentHub.pendingProjectMove", { plan: {}, keys: [projects[0].id], nextProjects: [] });
  await p.runTurn("must wait", "codex", [], projects[0].id, false, undefined, slot.chatId);
  assert.equal(messages.at(-1)?.type, "error"); assert.equal(messages.at(-1)?.chatId, slot.chatId);
  assert.equal(messages.at(-1)?.path, projects[0].id);
});

function gate() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
test("duplicating a profile confirmed after archival cannot revive the moved source", async () => {
  const { p, h, projects } = await setup(); const confirmation = gate(); const asked = gate();
  h.warning = async (...args) => { if (args[0].startsWith("Создать")) { asked.resolve(); return confirmation.promise; } return args.at(-1); };
  const duplicate = p.duplicateProject(projects[0].id, false); await asked.promise;
  await p.archiveProject(projects[0].id); confirmation.resolve("Создать копию"); await duplicate;
  assert.equal(p.getProjects().length, 0); assert.equal(p.getArchivedProjects().length, 1);
  await p.restoreProject(projects[0].id); assert.equal(p.getProjects().length, 1);
});

test("stale folder picker cannot register a source moved to archive while dialog was open", async () => {
  const { p, h, folder, projects } = await setup(); const picked = gate(); const asked = gate();
  h.open = async () => { asked.resolve(); return picked.promise; };
  const add = p.addProject(); await asked.promise; await p.archiveProject(projects[0].id);
  picked.resolve([{ fsPath: folder }]); await add;
  assert.equal(p.getProjects().length, 0); assert.equal(p.getArchivedProjects().length, 1);
});

test("stale delete confirmation cannot remove archived profile or its files", async () => {
  const { p, h, projects } = await setup(); const confirmation = gate(); const asked = gate();
  h.warning = async (...args) => { if (args[0].startsWith("Удалить проект")) { asked.resolve(); return confirmation.promise; } return args.at(-1); };
  const deletion = p.deleteProject(projects[0].id); await asked.promise;
  await p.archiveProject(projects[0].id); confirmation.resolve("Убрать из списка"); await deletion;
  assert.equal(p.getArchivedProjects().length, 1);
});

test("native project edit confirmed after archive cannot overwrite archived registry", async () => {
  const { p, h, projects } = await setup(); const input = gate(); const asked = gate();
  h.pick = async (items) => items.find((item) => item.field?.key === "name");
  h.input = async () => { asked.resolve(); return input.promise; };
  const editing = p.editProject(); await asked.promise; await p.archiveProject(projects[0].id);
  input.resolve("New title"); await editing;
  assert.equal(p.getArchivedProjects().length, 1); assert.equal(p.getProjects().length, 0);
});

test("copy reservation prevents archive while long copy leaves unrelated mutations unblocked", async (t) => {
  const { p, h, projects } = await setup(); const copying = gate(); const finish = gate(); const cp = nodeFs.promises.cp;
  nodeFs.promises.cp = async (...args) => { copying.resolve(); await finish.promise; await cp(...args); };
  let duplicate;
  t.after(async () => { finish.resolve(); if (duplicate) await duplicate; nodeFs.promises.cp = cp; });
  duplicate = p.duplicateProject(projects[0].id, true); await copying.promise;
  // A rejected concurrent copy must not release the first copy's reservation.
  await p.duplicateProject(projects[0].id, true);
  await p.archiveProject(projects[0].id); assert.equal(h.moves.length, 0);
  await p.onMessage({ type: "moveProject", path: projects[0].id, direction: "down" });
  finish.resolve(); await duplicate;
  assert.equal(p.getProjects().length, 2);
});

test("project reorder preserves effective selection when it previously used the first-row fallback", async () => {
  const { p, h, parent, projects } = await setup();
  const second = { id: "project-second", name: "Second", path: join(parent, "Second") }; await mkdir(second.path); h.settings.projects.push(second);
  assert.equal(p.getActivePathRaw(), undefined); assert.equal(p.getActiveProject().id, projects[0].id);
  await p.onMessage({ type: "reorderProjects", paths: [second.id, projects[0].id] });
  assert.equal(p.getActiveProject().id, projects[0].id);
  p.messages.length = 0;
  await p.onMessage({ type: "moveProject", path: projects[0].id, direction: "up" });
  assert.equal(p.messages.some((event) => event.type === "transcript"), false);
});

test("stale archived JSON, import and settings cannot hide a restored project", async () => {
  const { p, h, parent, folder, projects } = await setup(); await p.archiveProject(projects[0].id);
  const archived = p.collectAllSettings().projects[0]; const snapshot = JSON.stringify({ projects: [archived] });
  await p.restoreProject(projects[0].id);
  await p.applyConfigJson(snapshot); assert.equal(p.getProjects().length, 1); assert.equal(p.getArchivedProjects().length, 0);
  h.pickedPath = join(parent, "stale-archive.json"); await writeFile(h.pickedPath, snapshot); await p.importSettings();
  assert.equal(p.getProjects().length, 1); assert.equal(p.getArchivedProjects().length, 0);
  await p.applySettings({ project: archived, claude: {}, codex: {} });
  assert.equal(p.getProjects().length, 1); assert.equal(p.getArchivedProjects().length, 0);
  assert.equal(await readFile(join(folder, "file.txt"), "utf8"), "content"); assert.equal(h.moves.length, 2);
});

test("recovery keeps journal when a profile path was edited after interrupted move", async () => {
  const { p, h, folder, parent, projects } = await setup(); let moves = 0;
  h.beforeUpdate = async (key) => { if (key === "projects") throw new Error("read-only settings"); };
  h.beforeMove = async () => { if (++moves === 2) throw new Error("rollback blocked"); };
  await p.archiveProject(projects[0].id); const pending = p.context.globalState.get("agentHub.pendingProjectMove"); assert.ok(pending);
  h.beforeUpdate = undefined; h.beforeMove = undefined; h.settings.projects[0].path = join(parent, "changed");
  await p.recoverPendingProjectMove();
  assert.ok(p.context.globalState.get("agentHub.pendingProjectMove"));
  assert.equal(await readFile(join(pending.plan.destination, "file.txt"), "utf8"), "content");
  h.settings.projects[0].path = folder; await p.recoverPendingProjectMove();
  assert.equal(p.context.globalState.get("agentHub.pendingProjectMove"), undefined); assert.equal(p.getArchivedProjects().length, 1);
});
