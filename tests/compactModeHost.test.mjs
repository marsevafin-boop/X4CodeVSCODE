import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-compact-host-"));
const key = Symbol.for("agent-hub-compact-host"); let current;
globalThis[key] = { get current() { return current; } };
after(async () => { delete globalThis[key]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "provider.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "compact-host-stubs", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-compact-host")].current';
      if (path === "vscode") return { contents: `export const workspace={getConfiguration:(section)=>({get:(name,fallback)=>section==="zenMode"&&name==="centerLayout"?${h}.centered:fallback,update:()=>{throw Error("unexpected workbench setting mutation")}})};export const window={createWebviewPanel:()=>${h}.createPanel(),showErrorMessage:(text)=>${h}.errors.push(text)};export const commands={executeCommand:async(id,...args)=>{${h}.commands.push([id,...args]);if(${h}.fail===id){${h}.fail=undefined;throw Error("native failure");}}};export const Uri={joinPath:(...parts)=>parts.join("/")},ViewColumn={One:1},ConfigurationTarget={},ProgressLocation={},env={};export class ThemeIcon{};` };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw Error("unexpected external process")};' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>"";export const buildFinishPrompt=()=>"";' };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{};export const enableTailscaleFunnel=()=>{};export const generateToken=()=>"";export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>"";export default {};' };
      return { contents: 'export class ClaudeBackend{};export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{};export const codexDefaultModel=()=>"test";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
const PREF = "agentHub.compactMode";
function panelFixture() {
  const handlers = new Set(), disposals = new Set();
  const panel = { messages: [], handlers, webview: { options: {}, html: "", postMessage: (event) => panel.messages.push(event), onDidReceiveMessage: (handler) => { handlers.add(handler); return { dispose: () => handlers.delete(handler) }; } },
    onDidDispose: (handler) => { disposals.add(handler); return { dispose: () => disposals.delete(handler) }; }, reveal() {},
    dispose() { for (const handler of [...disposals]) handler(); }, async send(message) { for (const handler of handlers) await handler(message); } };
  return panel;
}
function fixture(saved = false) {
  const workspace = new Map([[PREF, saved]]), updates = [];
  const h = { workspace, updates, commands: [], errors: [], panels: [], centered: true };
  h.createPanel = () => { const panel = panelFixture(); h.panels.push(panel); return panel; };
  current = h;
  h.p = Object.create(ChatViewProvider.prototype);
  h.p.context = { workspaceState: { get: (name, fallback) => workspace.has(name) ? workspace.get(name) : fallback,
    update: async (name, value) => { updates.push([name, value]); workspace.set(name, value); } }, extensionUri: "extension", subscriptions: [] };
  h.p.renderHtml = () => "<html></html>"; h.p.ensureMultiChats = async () => {};
  h.p.postRuntimeSettings = () => {}; h.p.postMultiModels = () => {};
  h.p.chatSlots = [{ chatId: "chat-stable", projectPath: "project-stable", recordId: "record-stable", agent: "codex" }];
  h.p.runs = new Map([["chat-stable", new AbortController()]]);
  h.native = () => h.commands.filter(([id]) => id !== "setContext").map(([id]) => id);
  h.settled = () => new Promise((resolve) => setImmediate(resolve));
  return h;
}

test("the local board button changes only compact preference and native layout while preserving runs and chat identity", async () => {
  const h = fixture(); const slots = structuredClone(h.p.chatSlots), run = h.p.runs.get("chat-stable");
  await h.p.openMultiChat(); const panel = h.panels[0]; await h.settled();
  await panel.send({ type: "setCompactMode", enabled: true });
  assert.deepEqual(h.native(), ["workbench.action.exitZenMode", "workbench.action.toggleZenMode", "workbench.action.toggleCenteredLayout"]);
  assert.deepEqual(h.updates, [[PREF, true]]); assert.deepEqual(h.p.chatSlots, slots); assert.equal(h.p.runs.get("chat-stable"), run); assert.equal(run.signal.aborted, false);
  assert.deepEqual(panel.messages.at(-1), { type: "compactMode", enabled: true, pending: false });
  assert.ok(h.commands.some(([id, name, enabled]) => id === "setContext" && name === PREF && enabled === true));
});
test("remote clients cannot change native layout or its preference", async () => {
  const h = fixture(); const received = [];
  await h.p.onMessage({ type: "setCompactMode", enabled: true }, "remote", { send: (event) => received.push(event) });
  assert.deepEqual(h.commands, []); assert.deepEqual(h.updates, []); assert.match(received[0]?.text ?? "", /VS Code/);
});
test("single-chat surfaces and malformed enabled payloads cannot invoke the native toggle", async () => {
  const h = fixture(); await h.p.openMultiChat(); await h.settled(); h.commands = [];
  for (const enabled of [undefined, null, "true", 1, {}, []]) await h.p.onMessage({ type: "setCompactMode", enabled }, "vscode", undefined, "multi-panel");
  for (const surface of [undefined, "view", "panel"]) await h.p.onMessage({ type: "setCompactMode", enabled: true }, "vscode", undefined, surface);
  assert.deepEqual(h.native(), []); assert.deepEqual(h.updates, []);
});
test("public palette toggle opens a multichat board and escape exit restores its layout", async () => {
  const h = fixture(); await h.p.toggleCompactMode();
  assert.equal(h.panels.length, 1); assert.equal(h.workspace.get(PREF), true);
  await h.p.exitCompactMode(); assert.equal(h.workspace.get(PREF), false); assert.equal(h.native().at(-1), "workbench.action.exitZenMode");
});
test("saved compact preference is restored for a manually reopened board and not toggled again by ready events", async () => {
  const h = fixture(true); await h.p.openMultiChat(); await h.settled(); const panel = h.panels[0];
  const before = h.native(); await panel.send({ type: "ready" }); await panel.send({ type: "multiStateReady", chatIds: [] });
  assert.deepEqual(h.native(), before); assert.deepEqual(h.updates, []);
  assert.ok(panel.messages.filter((event) => event.type === "compactMode").length >= 3);
  assert.deepEqual(panel.messages.at(-1), { type: "compactMode", enabled: true, pending: false });
});
test("a newly mounted disabled board receives authoritative compact state on readiness", async () => {
  const h = fixture(); await h.p.openMultiChat(); await h.settled(); const panel = h.panels[0]; panel.messages = [];
  await panel.send({ type: "multiStateReady", chatIds: [] });
  assert.deepEqual(panel.messages.at(-1), { type: "compactMode", enabled: false, pending: false }); assert.deepEqual(h.native(), []);
});
test("serializer attachment restores compact layout and closing it exits without erasing the saved preference", async () => {
  const h = fixture(true); const panel = panelFixture(); await h.p.restoreMultiChatPanel(panel, undefined); await h.settled();
  assert.equal(h.native().filter((id) => id === "workbench.action.toggleZenMode").length, 1);
  panel.dispose(); await h.settled(); assert.equal(h.native().at(-1), "workbench.action.exitZenMode"); assert.equal(h.workspace.get(PREF), true); assert.deepEqual(h.updates, []);
  assert.ok(h.commands.some(([id, name, value]) => id === "setContext" && name === PREF && value === false));
});
test("native failure sends a final unlocked board error instead of falsely reporting success", async () => {
  const h = fixture(); await h.p.openMultiChat(); await h.settled(); h.fail = "workbench.action.toggleZenMode";
  await h.panels[0].send({ type: "setCompactMode", enabled: true }); const state = h.panels[0].messages.at(-1);
  assert.equal(state.type, "compactMode"); assert.equal(state.enabled, false); assert.equal(state.pending, false); assert.match(state.error, /native failure/); assert.deepEqual(h.updates, []);
});

test("rapid palette toggles return the board to its original density and native layout", async () => {
  const h = fixture(); await h.p.openMultiChat(); await h.settled();
  await Promise.all([h.p.toggleCompactMode(), h.p.toggleCompactMode()]);
  assert.equal(h.workspace.get(PREF), false); assert.deepEqual(h.updates, [[PREF, true], [PREF, false]]);
});
test("closing after a failed saved restore clears the compact keybinding context", async () => {
  const h = fixture(true); h.fail = "workbench.action.toggleZenMode"; await h.p.openMultiChat(); await h.settled(); h.commands = [];
  h.panels[0].dispose(); await h.settled();
  assert.ok(h.commands.some(([id, name, value]) => id === "setContext" && name === PREF && value === false));
});

test("late messages from a disposed panel cannot change the replacement board or reopen a closed board", async () => {
  const h = fixture(); await h.p.openMultiChat(); await h.settled();
  const panel = h.panels[0], retainedCallback = [...panel.handlers][0]; panel.dispose(); await h.settled();
  await retainedCallback({ type: "setCompactMode", enabled: true });
  assert.equal(h.p.multiPanel, null); assert.equal(h.panels.length, 1); assert.equal(h.workspace.get(PREF), false);
  await h.p.openMultiChat(); await h.settled(); h.commands = [];
  await retainedCallback({ type: "setCompactMode", enabled: true });
  assert.deepEqual(h.native(), []); assert.deepEqual(h.updates, []); assert.equal(h.workspace.get(PREF), false);
});

for (const method of ["setCompactMode", "toggleCompactMode"]) {
  for (const replacement of [false, true]) {
    test(`${method} cancels delayed enabling when its opening panel closes${replacement ? " and is replaced" : ""}`, async () => {
      const h = fixture(); let release;
      const blocked = new Promise((resolve) => { release = resolve; }); h.p.ensureMultiChats = () => blocked;
      const opening = method === "setCompactMode" ? h.p.setCompactMode(true) : h.p.toggleCompactMode();
      assert.equal(h.panels.length, 1); h.panels[0].dispose();
      if (replacement) { h.p.ensureMultiChats = async () => {}; await h.p.openMultiChat(); }
      release(); await opening; await h.settled();
      assert.equal(h.workspace.get(PREF), false); assert.deepEqual(h.updates, []); assert.deepEqual(h.native(), []);
      assert.equal(!!h.p.multiPanel, replacement);
    });
  }
}
