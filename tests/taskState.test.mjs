import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-task-state-"));
after(() => rm(temp, { recursive: true, force: true }));
const outfile = join(temp, "task.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/shared/taskState.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
const { TASK_FIELDS, TASK_FIELD_MAX_CHARS, TASK_TOTAL_MAX_CHARS, TASK_INSERT_MAX_CHARS, emptyTaskFields,
  taskFields, validateTaskFields, isTaskIdentity, isTaskState, hasTaskContent, shouldPreserveTask, formatTaskCheckpoint, appendTaskCheckpoint } = await import(process.env.AGENT_HUB_TASK_DIRECT_SOURCE === "1"
    ? new URL("../src/shared/taskState.ts", import.meta.url).href : pathToFileURL(outfile).href);
const fields = (overrides = {}) => ({ ...emptyTaskFields(), ...overrides });
const state = (overrides = {}) => ({ ...fields({ outcome: "Результат" }), schemaVersion: 1, revision: 1, updatedAt: 1, ...overrides });

test("missing notes need no migration; empty notes and whitespace are not user content", () => {
  assert.equal(isTaskState(undefined), false); assert.equal(hasTaskContent(undefined), false);
  assert.equal(hasTaskContent(state({ outcome: " \n\t" })), false);
  assert.equal(hasTaskContent(state()), true);
  assert.equal(Object.values(emptyTaskFields()).every(value => value === ""), true);
  const first = emptyTaskFields(); first.outcome = "modified"; assert.equal(emptyTaskFields().outcome, "");
});

test("pruning preserves unsupported saved data while known empty notes remain reusable", () => {
  assert.equal(shouldPreserveTask(undefined), false);
  assert.equal(shouldPreserveTask(state({ outcome: " \n" })), false);
  assert.equal(shouldPreserveTask(state()), true);
  for (const unknown of [null, false, [], { schemaVersion: 99, payload: "future data" }, state({ revision: "bad" })]) {
    assert.equal(shouldPreserveTask(unknown), true);
  }
});

test("fields retain exact Unicode, multiline and punctuation strings without coercion", () => {
  const input = fields({ outcome: "  Привет 🧪 é 中文 \n'; <tag> $()  " });
  assert.equal(validateTaskFields(input), undefined);
  assert.deepEqual(taskFields(state(input)), input);
});

test("untrusted field values and extra or missing fields fail validation", () => {
  for (const value of [undefined, null, [], 1, false, "text", {}, fields({ outcome: 1 }), fields({ scope: null }), fields({ blockers: [] }), { ...fields(), extra: "no" }]) {
    assert.equal(typeof validateTaskFields(value), "string");
  }
  const missing = fields(); delete missing.evidence; assert.equal(typeof validateTaskFields(missing), "string");
  const large = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [String(i), "x"]));
  assert.equal(typeof validateTaskFields(large), "string");
});

test("individual and total bounds accept their exact limit and reject one character more", () => {
  assert.equal(validateTaskFields(fields({ outcome: "x".repeat(TASK_FIELD_MAX_CHARS) })), undefined);
  assert.ok(validateTaskFields(fields({ outcome: "x".repeat(TASK_FIELD_MAX_CHARS + 1) })));
  const maximum = fields(); let remaining = TASK_TOTAL_MAX_CHARS;
  for (const field of TASK_FIELDS) { maximum[field] = "x".repeat(Math.min(remaining, TASK_FIELD_MAX_CHARS)); remaining -= maximum[field].length; }
  assert.equal(validateTaskFields(maximum), undefined);
  const empty = TASK_FIELDS.find(field => !maximum[field]); maximum[empty] = "x";
  assert.ok(validateTaskFields(maximum));
});

test("state metadata is strict and cannot masquerade as verified completion or permissions", () => {
  assert.equal(isTaskState(state()), true);
  for (const patch of [{ schemaVersion: 2 }, { schemaVersion: "1" }, { revision: 0 }, { revision: -1 }, { revision: 1.1 },
    { revision: NaN }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { updatedAt: -1 }, { updatedAt: Infinity }, { verified: true }, { permission: true }]) {
    assert.equal(isTaskState(state(patch)), false);
  }
});

test("identity requires exact bounded project, record and generation values", () => {
  const identity = { projectKey: "project-one", recordId: "record-1", createdAt: 1 };
  assert.equal(isTaskIdentity(identity), true);
  for (const value of [null, [], {}, { ...identity, projectKey: "" }, { ...identity, recordId: 1 }, { ...identity, createdAt: "1" },
    { ...identity, createdAt: -1 }, { ...identity, createdAt: Infinity }, { ...identity, recordId: "x".repeat(513) }, { ...identity, extra: true }]) {
    assert.equal(isTaskIdentity(value), false);
  }
});

test("explicit insertion is bounded user notes and preserves an existing composer draft exactly", () => {
  const input = fields({ outcome: "Сделать", evidence: "Ещё не проверено", nextStep: "Запустить тесты" });
  const formatted = formatTaskCheckpoint(input);
  assert.match(formatted, /Заметки пользователя/); assert.match(formatted, /не подтверждают/); assert.match(formatted, /не дают разрешений/);
  assert.match(formatted, /Сделать/); assert.match(formatted, /Ещё не проверено/);
  const draft = "  Мой черновик\n "; assert.equal(appendTaskCheckpoint(draft, input), `${draft}\n\n${formatted}`);
  assert.equal(appendTaskCheckpoint("", input), formatted);
  assert.equal(formatTaskCheckpoint(fields()), ""); assert.equal(formatTaskCheckpoint(null), "");
  assert.equal(appendTaskCheckpoint(draft, fields()), draft);
  const maximum = fields(); for (const field of TASK_FIELDS.slice(0, 6)) maximum[field] = "я".repeat(TASK_FIELD_MAX_CHARS);
  assert.ok(formatTaskCheckpoint(maximum).length <= TASK_INSERT_MAX_CHARS);
});
