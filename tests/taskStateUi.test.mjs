import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-task-ui-"));
const hookKey = Symbol.for("agent-hub-task-ui-hooks");
after(async () => { delete globalThis[hookKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "checkpoint.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../webview/TaskCheckpoint.tsx", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "controlled-react-host", setup(b) {
    b.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, ({ path }) => ({ path, namespace: "ui" }));
    b.onLoad({ filter: /.*/, namespace: "ui" }, ({ path }) => path.endsWith("jsx-runtime")
      ? { contents: 'export const Fragment="fragment";export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;' }
      : { contents: 'const h=()=>globalThis[Symbol.for("agent-hub-task-ui-hooks")];export const useState=(v)=>h().state(v);export const useRef=(v)=>h().ref(v);export const useEffect=(f,d)=>h().effect(f,d);export const useId=()=>h().ref("task-hint").current;' });
  } }],
});
const { TaskCheckpoint } = await import(pathToFileURL(outfile));
const fields = (patch = {}) => ({ outcome: "", scope: "", doneWhen: "", requiredChecks: "", candidate: "", completed: "", blockers: "", nextStep: "", evidence: "", ...patch });
const snapshot = (revision = 0, patch = {}) => ({ type: "taskState", identity: { projectKey: "project-one", recordId: "record-one", createdAt: 1 }, revision,
  ...(revision ? { task: { ...fields({ outcome: "Сохранено" }), schemaVersion: 1, revision, updatedAt: 1 } } : {}), ...patch });
const textOf = node => node == null || typeof node === "boolean" ? "" : Array.isArray(node) ? node.map(textOf).join("") : typeof node === "object" ? textOf(node.props?.children) : String(node);
function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.props?.children)] : []; }
function harness(initial = snapshot()) {
  const slots = []; let cursor = 0, dirty = false, effects = [];
  const hookHost = {
    state(initialValue) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initialValue === "function" ? initialValue() : initialValue;
      return [slots[i], value => { const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    ref(initialValue) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initialValue }; return slots[i]; },
    effect(fn, dependencies) { const i = cursor++, previous = slots[i]; if (!previous || dependencies.some((value, j) => !Object.is(value, previous[j]))) { slots[i] = dependencies; effects.push(fn); } },
  };
  const h = { snapshot: initial, saves: [], inserts: [], tree: null };
  h.render = () => { for (let n = 0; n < 20; n++) { globalThis[hookKey] = hookHost; cursor = 0; dirty = false; effects = [];
    h.tree = TaskCheckpoint({ snapshot: h.snapshot, onSave: message => h.saves.push(message), onInsert: value => h.inserts.push(value) });
    effects.forEach(effect => effect()); if (!dirty) return; } assert.fail("render did not settle"); };
  h.all = type => nodes(h.tree).filter(node => node.type === type);
  h.button = label => h.all("button").find(node => textOf(node.props.children) === label);
  h.edit = (index, value) => { h.all("textarea")[index].props.onChange({ target: { value } }); h.render(); };
  h.click = label => { const button = h.button(label); assert.ok(button, `missing button ${label}`); assert.equal(!!button.props.disabled, false); button.props.onClick(); h.render(); };
  h.render(); return h;
}

test("card starts collapsed and exposes nine bounded native labelled text areas", () => {
  const h = harness(); assert.equal(!!h.all("details")[0].props.open, false);
  assert.equal(h.all("textarea").length, 9); assert.equal(h.all("label").length, 9);
  assert.equal(h.all("textarea").every(node => node.props.maxLength === 2000), true);
  assert.equal(h.button("Сохранить").props.disabled, true);
  assert.equal(h.button("Вставить в сообщение").props.disabled, true);
  assert.deepEqual(h.saves, []); assert.deepEqual(h.inserts, []);
});

test("editing stays local; save explicitly sends the current identity, revision and exact text", () => {
  const h = harness(); h.edit(0, "Мой результат 🧪");
  assert.deepEqual(h.saves, []); assert.deepEqual(h.inserts, []);
  h.click("Сохранить"); assert.equal(h.saves.length, 1);
  const saved = h.saves[0]; assert.deepEqual(saved.identity, h.snapshot.identity); assert.equal(saved.revision, 0); assert.equal(saved.fields.outcome, "Мой результат 🧪");
  h.snapshot = snapshot(1, { requestId: saved.requestId, task: { ...saved.fields, schemaVersion: 1, revision: 1, updatedAt: 2 } }); h.render();
  assert.equal(h.button("Сохранить").props.disabled, true); assert.equal(h.all("textarea")[0].props.value, "Мой результат 🧪");
});

test("insert is a separate explicit action and never triggers saving", () => {
  const h = harness(); h.edit(0, "Draft notes"); h.click("Вставить в сообщение");
  assert.equal(h.inserts.length, 1); assert.equal(h.inserts[0].outcome, "Draft notes"); assert.deepEqual(h.saves, []);
});

test("persistence rejection keeps editable text and a visible error for retry", () => {
  const h = harness(); h.edit(0, "Keep this text"); h.click("Сохранить");
  h.snapshot = snapshot(0, { requestId: h.saves[0].requestId, error: "Не удалось сохранить" }); h.render();
  assert.equal(h.all("textarea")[0].props.value, "Keep this text");
  assert.ok(nodes(h.tree).some(node => node.props?.role === "alert"));
  h.click("Сохранить"); assert.equal(h.saves.length, 2);
});

test("a newer external revision keeps unsaved edits until the user chooses a version", () => {
  const h = harness(snapshot(1)); h.edit(0, "My local change"); h.snapshot = snapshot(2); h.render();
  assert.equal(h.all("textarea")[0].props.value, "My local change");
  assert.equal(h.button("Сохранить").props.disabled, true);
  assert.ok(h.button("Загрузить сохранённое"));
  h.click("Сохранить моё"); assert.equal(h.saves[0].revision, 2); assert.equal(h.saves[0].fields.outcome, "My local change");
});

test("loading a saved revision is explicit and a clean card follows external updates", () => {
  const h = harness(snapshot(1)); h.edit(0, "My local change"); h.snapshot = snapshot(2); h.render(); h.click("Загрузить сохранённое");
  assert.equal(h.all("textarea")[0].props.value, "Сохранено"); assert.equal(h.button("Сохранить").props.disabled, true);
  h.snapshot = snapshot(3, { task: { ...fields({ outcome: "Newest" }), schemaVersion: 1, revision: 3, updatedAt: 3 } }); h.render();
  assert.equal(h.all("textarea")[0].props.value, "Newest"); assert.deepEqual(h.saves, []);
});

test("total text overflow is visible and blocks both save and insertion", () => {
  const h = harness(); for (let i = 0; i < 7; i++) h.edit(i, "x".repeat(2000));
  assert.ok(nodes(h.tree).some(node => node.props?.role === "alert"));
  assert.equal(h.button("Сохранить").props.disabled, true); assert.equal(h.button("Вставить в сообщение").props.disabled, true);
});
