import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-task-app-"));
const hookKey = Symbol.for("agent-hub-task-app-hooks");
let commands = [], listeners = new Set();
const originalGlobals = new Map(["window", "localStorage", "acquireVsCodeApi"].map(key => [key, globalThis[key]]));
globalThis.window = { addEventListener: (_name, listener) => listeners.add(listener), removeEventListener: (_name, listener) => listeners.delete(listener), innerHeight: 800 };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.acquireVsCodeApi = () => ({ postMessage: message => commands.push(message) });
after(async () => { for (const [key, value] of originalGlobals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  delete globalThis[hookKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "app.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../webview/App.tsx", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "controlled-app-react-host", setup(b) {
    b.onResolve({ filter: /^(react(?:\/jsx-runtime)?|react-markdown|remark-gfm)$/ }, ({ path }) => ({ path, namespace: "ui" }));
    b.onLoad({ filter: /.*/, namespace: "ui" }, ({ path }) => {
      if (path.endsWith("jsx-runtime")) return { contents: 'export const Fragment="fragment";export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;' };
      if (path === "react") return { contents: 'const h=()=>globalThis[Symbol.for("agent-hub-task-app-hooks")];export const useState=(v)=>h().state(v);export const useRef=(v)=>h().ref(v);export const useEffect=(f,d)=>h().effect(f,d);export const useMemo=(f,d)=>h().memo(f,d);export const useCallback=(f,d)=>h().memo(()=>f,d);export const useId=()=>h().ref("task-hint").current;' };
      return { contents: 'export default function Stub(){ return null; }' };
    });
  } }],
});
const { App } = await import(pathToFileURL(outfile));
const ChatTile = App().type;
const fields = { outcome: "Checkpoint result", scope: "", doneWhen: "", requiredChecks: "", candidate: "", completed: "", blockers: "", nextStep: "", evidence: "" };
const project = { id: "project-one", name: "One", path: "/same/folder" };
const identity = { projectKey: project.id, recordId: "record-one", createdAt: 1 };
const task = { ...fields, schemaVersion: 1, revision: 1, updatedAt: 1 };
function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.props?.children)] : []; }
const textOf = node => node == null || typeof node === "boolean" ? "" : Array.isArray(node) ? node.map(textOf).join("") : typeof node === "object" ? textOf(node.props?.children) : String(node);
function hookRenderer() {
  const slots = []; let cursor = 0, dirty = false, effects = [];
  const hooks = {
    state(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => { const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    ref(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    memo(fn, deps) { const i = cursor++, previous = slots[i]; if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) slots[i] = { deps, value: fn() }; return slots[i].value; },
    effect(fn, deps) { const i = cursor++, previous = slots[i]; if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
      previous?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } },
  };
  return {
    render(Component, props) { for (let n = 0; n < 30; n++) { globalThis[hookKey] = hooks; cursor = 0; dirty = false; effects = [];
      const tree = Component(props); effects.forEach(effect => effect()); if (!dirty) return tree; } assert.fail("render did not settle"); },
    dispose: () => slots.forEach(slot => slot?.cleanup?.()),
  };
}
function setup(props = {}) {
  commands = []; listeners = new Set();
  const parent = hookRenderer(); let child, childKey;
  const h = { tree: null, editor: null };
  h.render = () => {
    h.tree = parent.render(ChatTile, props);
    const card = h.card();
    // Native keyed reconciliation: removing the editor or changing its identity discards local hooks.
    if (!card || card.key !== childKey) { child?.dispose(); child = undefined; childKey = card?.key; }
    if (card) { child ??= hookRenderer(); h.editor = child.render(card.type, card.props); } else h.editor = null;
  };
  h.deliver = message => { [...listeners].forEach(listener => listener({ data: message })); h.render(); };
  h.card = () => nodes(h.tree).find(node => node.props?.snapshot?.type === "taskState");
  h.composer = () => nodes(h.tree).find(node => node.type === "textarea" && node.props?.placeholder?.startsWith("Сообщение"));
  h.commands = () => commands;
  h.noteFields = () => nodes(h.editor).filter(node => node.type === "textarea");
  h.editNotes = value => { h.noteFields()[0].props.onChange({ target: { value } }); h.render(); };
  h.click = (label, inEditor = false) => { const button = nodes(inEditor ? h.editor : h.tree).find(node => node.type === "button" && textOf(node.props.children).trim() === label);
    assert.ok(button, `missing ${label}`); assert.equal(!!button.props.disabled, false); button.props.onClick(); h.render(); };
  h.dispose = () => { parent.dispose(); child?.dispose(); };
  h.render();
  h.deliver({ type: "projects", projects: [project], activePath: project.id, ...(props.chatId ? { chatId: props.chatId } : {}) });
  h.deliver({ type: "agentInfo", agent: "codex", path: project.id, recordId: identity.recordId, ...(props.chatId ? { chatId: props.chatId } : {}) });
  return h;
}

test("hydration never changes or sends the composer; explicit insert appends to its existing draft", () => {
  const h = setup();
  h.composer().props.onChange({ target: { value: "Existing draft\n " } }); h.render();
  h.deliver({ type: "taskState", path: project.id, identity, revision: 1, task });
  assert.equal(h.composer().props.value, "Existing draft\n "); assert.ok(h.card());
  assert.equal(h.commands().some(message => ["send", "steer", "saveTaskState"].includes(message.type)), false);
  h.card().props.onInsert(fields); h.render();
  assert.ok(h.composer().props.value.startsWith("Existing draft\n \n\nЗаметки пользователя"));
  assert.ok(h.composer().props.value.includes(fields.outcome));
  assert.equal(h.commands().some(message => ["send", "steer", "saveTaskState"].includes(message.type)), false);
  h.dispose();
});

test("a tile scopes saves and rejects task events for other chats, records, generations and revisions", () => {
  const chatId = "chat-task-fixture";
  const h = setup({ chatId, initialProjectPath: project.id, initialRecordId: identity.recordId, initialAgent: "codex" });
  const currentIdentity = { ...identity, createdAt: 2 };
  const event = { type: "taskState", chatId, path: project.id, identity: currentIdentity, revision: 2, task: { ...task, revision: 2 } };
  h.deliver(event); assert.equal(h.card().props.snapshot.revision, 2);
  for (const stale of [{ ...event, chatId: "chat-other-fixture" }, { ...event, chatId: undefined }, { ...event, identity: { ...currentIdentity, recordId: "other" } },
    { ...event, identity }, { ...event, revision: 1 }]) {
    h.deliver(stale); assert.deepEqual(h.card().props.snapshot, event);
  }
  h.card().props.onSave({ type: "saveTaskState", identity: currentIdentity, revision: 2, fields, requestId: "save-ui" });
  assert.equal(h.commands().at(-1).chatId, chatId); assert.equal(h.commands().at(-1).type, "saveTaskState");
  h.dispose();
});

test("changing a tile record clears the old card before new hydration and rejects late old responses", () => {
  const chatId = "chat-task-fixture";
  const h = setup({ chatId, initialProjectPath: project.id, initialRecordId: identity.recordId, initialAgent: "codex" });
  const old = { type: "taskState", chatId, path: project.id, identity, revision: 1, task };
  h.deliver(old); assert.ok(h.card());
  h.deliver({ type: "multiState", projects: [project], chats: [{ chatId, projectPath: project.id, recordId: "record-two", agent: "codex", title: "Two" }] });
  assert.equal(h.card(), undefined);
  h.deliver(old); assert.equal(h.card(), undefined);
  h.deliver({ type: "taskState", chatId, path: project.id, identity: { ...identity, recordId: "record-two", createdAt: 2 }, revision: 0 });
  assert.equal(h.card().props.snapshot.task, undefined); h.dispose();
});

test("stale session and provider acknowledgements cannot clear notes or change their binding", () => {
  const h = setup(); const snapshot = { type: "taskState", path: project.id, identity, revision: 1, task };
  h.deliver(snapshot); h.editNotes("Unsaved protected notes");
  h.deliver({ type: "agentInfo", path: project.id, recordId: "obsolete-record", agent: "claude", contextRequestId: "obsolete-session-request" });
  assert.deepEqual(h.card()?.props.snapshot, snapshot); assert.equal(h.noteFields()[0].props.value, "Unsaved protected notes");
  const provider = nodes(h.tree).find(node => node.type === "select" && node.props["aria-label"] === "Провайдер чата");
  provider.props.onChange({ target: { value: "claude" } }); h.render();
  h.deliver({ type: "agentInfo", path: project.id, recordId: "obsolete-record", agent: "codex", requestedAgent: "codex" });
  assert.deepEqual(h.card()?.props.snapshot, snapshot); assert.equal(h.noteFields()[0].props.value, "Unsaved protected notes");
  h.dispose();
});

test("accepted new-session acknowledgements hydrate the new binding after guarded early events", () => {
  const h = setup(); h.deliver({ type: "taskState", path: project.id, identity, revision: 1, task }); h.click("＋ Новая");
  const requestId = h.commands().find(message => message.type === "newSession").requestId;
  const nextIdentity = { ...identity, recordId: "record-next", createdAt: 2 };
  h.deliver({ type: "agentInfo", path: project.id, recordId: nextIdentity.recordId, agent: "codex" });
  h.deliver({ type: "taskState", path: project.id, identity: nextIdentity, revision: 0 });
  h.deliver({ type: "agentInfo", path: project.id, recordId: nextIdentity.recordId, agent: "codex", contextRequestId: requestId });
  assert.equal(h.commands().at(-1).type, "ready", "accepted changed bindings request fresh task hydration");
  h.deliver({ type: "taskState", path: project.id, identity: nextIdentity, revision: 0 });
  assert.deepEqual(h.card().props.snapshot.identity, nextIdentity); assert.equal(h.noteFields()[0].props.value, ""); h.dispose();
});

test("opening and closing settings preserves unsaved checkpoint edits without sending them", () => {
  const h = setup(); h.deliver({ type: "taskState", path: project.id, identity, revision: 1, task });
  h.editNotes("Keep this unsaved draft"); h.click("⚙"); assert.equal(h.editor.props.hidden, true); h.click("← Назад");
  assert.equal(h.editor.props.hidden, false);
  assert.equal(h.noteFields()[0].props.value, "Keep this unsaved draft");
  assert.equal(h.commands().some(message => ["saveTaskState", "send", "steer"].includes(message.type)), false); h.dispose();
});

test("settings roundtrip retains an outstanding note save and its later failure keeps the edited text", () => {
  const h = setup(); h.deliver({ type: "taskState", path: project.id, identity, revision: 1, task });
  h.editNotes("Pending local change"); h.click("Сохранить", true);
  const request = h.commands().find(message => message.type === "saveTaskState");
  h.click("⚙"); h.click("← Назад");
  assert.equal(h.noteFields()[0].props.value, "Pending local change"); assert.equal(h.noteFields()[0].props.disabled, true);
  h.deliver({ type: "taskState", path: project.id, identity, revision: 1, task, requestId: request.requestId, error: "Storage unavailable" });
  assert.equal(h.noteFields()[0].props.value, "Pending local change"); assert.equal(h.noteFields()[0].props.disabled, false);
  assert.ok(nodes(h.editor).some(node => node.props?.role === "alert"));
  h.click("Сохранить", true); assert.equal(h.commands().filter(message => message.type === "saveTaskState").length, 2); h.dispose();
});

test("a save failure received while settings is open preserves local notes and remains visible on return", () => {
  const h = setup(); h.deliver({ type: "taskState", path: project.id, identity, revision: 1, task });
  h.editNotes("Keep while hidden"); h.click("Сохранить", true); const request = h.commands().find(message => message.type === "saveTaskState");
  h.click("⚙");
  h.deliver({ type: "taskState", path: project.id, identity, revision: 1, task, requestId: request.requestId, error: "Storage unavailable" });
  h.click("← Назад");
  assert.equal(h.noteFields()[0].props.value, "Keep while hidden"); assert.ok(nodes(h.editor).some(node => node.props?.role === "alert")); h.dispose();
});

test("a new conversation selected while settings is open never inherits the old note draft", () => {
  const h = setup(); h.deliver({ type: "taskState", path: project.id, identity, revision: 1, task });
  h.editNotes("Old conversation only"); h.click("⚙");
  const nextIdentity = { ...identity, recordId: "record-next", createdAt: 2 };
  h.deliver({ type: "agentInfo", path: project.id, recordId: nextIdentity.recordId, agent: "codex" });
  h.deliver({ type: "taskState", path: project.id, identity: nextIdentity, revision: 0 }); h.click("← Назад");
  assert.deepEqual(h.card().props.snapshot.identity, nextIdentity); assert.equal(h.noteFields()[0].props.value, ""); h.dispose();
});
