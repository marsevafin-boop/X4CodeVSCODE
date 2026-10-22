import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "agent-hub-project-order-"));
after(() => rm(dir, { recursive: true, force: true }));
const outfile = join(dir, "order.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/shared/projectOrder.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
const { reconcileProjectOrder, moveInProjectOrder, applyActiveProjectOrder } = await import(pathToFileURL(outfile));

test("new projects retain discovery order when there is no saved order", () => {
  assert.deepEqual(reconcileProjectOrder(["first", "second"], []), ["first", "second"]);
  assert.deepEqual(reconcileProjectOrder([], ["removed"]), []);
  assert.deepEqual(reconcileProjectOrder([], []), []);
});

test("saved order keeps known keys once, drops removed keys, and appends new projects", () => {
  assert.deepEqual(
    reconcileProjectOrder(["one", "two", "three", "one", "four"], ["gone", "three", "one", "three", "gone"]),
    ["three", "one", "two", "four"],
  );
});

test("project keys are exact strings, including Unicode, paths, and object-property names", () => {
  const keys = ["проект 📁", "/folder with spaces", "__proto__", "constructor", ""];
  assert.deepEqual(reconcileProjectOrder(keys, [...keys].reverse()), [...keys].reverse());
});

test("reconciling order never mutates either input", () => {
  const known = Object.freeze(["one", "two", "three"]);
  const saved = Object.freeze(["two", "removed", "two"]);
  assert.deepEqual(reconcileProjectOrder(known, saved), ["two", "one", "three"]);
  assert.deepEqual(known, ["one", "two", "three"]);
  assert.deepEqual(saved, ["two", "removed", "two"]);
});

test("moving a project up swaps adjacent visible projects across archived positions", () => {
  assert.deepEqual(
    moveInProjectOrder(["one", "archived-a", "two", "archived-b", "three"], ["three", "one", "two"], "three", "up"),
    ["one", "archived-a", "three", "archived-b", "two"],
  );
});

test("moving a project down preserves every inactive position", () => {
  assert.deepEqual(
    moveInProjectOrder(["archived-a", "one", "archived-b", "two", "archived-c"], ["two", "one"], "one", "down"),
    ["archived-a", "two", "archived-b", "one", "archived-c"],
  );
});

test("moving a boundary project or a missing/inactive key leaves contents unchanged", () => {
  const order = Object.freeze(["archived", "one", "two"]);
  for (const [key, direction] of [["one", "up"], ["two", "down"], ["missing", "up"], ["archived", "down"], ["one", "sideways"]]) {
    assert.deepEqual(moveInProjectOrder(order, ["one", "two"], key, direction), order);
  }
  assert.deepEqual(moveInProjectOrder([], [], "missing", "up"), []);
  assert.deepEqual(moveInProjectOrder(["one", "archived"], ["one"], "one", "down"), ["one", "archived"]);
});

test("moving projects never mutates the full order or the active list", () => {
  const order = Object.freeze(["one", "archived", "two"]);
  const active = Object.freeze(["one", "two"]);
  assert.deepEqual(moveInProjectOrder(order, active, "two", "up"), ["two", "archived", "one"]);
  assert.deepEqual(order, ["one", "archived", "two"]);
  assert.deepEqual(active, ["one", "two"]);
});

test("a requested active permutation replaces only visible positions", () => {
  assert.deepEqual(
    applyActiveProjectOrder(["archived-a", "one", "archived-b", "two", "three", "archived-c"], ["one", "two", "three"], ["three", "one", "two"]),
    ["archived-a", "three", "archived-b", "one", "two", "archived-c"],
  );
});

test("applying an order reconciles duplicate full keys and appends new active projects", () => {
  assert.deepEqual(
    applyActiveProjectOrder(["one", "archived", "one"], ["one", "two", "two"], ["two", "one"]),
    ["two", "archived", "one"],
  );
});

test("requested orders reject missing, duplicate, unknown, inactive, or invalid keys", () => {
  const order = Object.freeze(["one", "archived", "two"]);
  const active = Object.freeze(["one", "two"]);
  for (const requested of [[], ["one"], ["one", "one"], ["one", "two", "extra"], ["one", "missing"], ["one", "archived"], ["one", null], null, undefined, "one,two"]) {
    assert.equal(applyActiveProjectOrder(order, active, requested), null);
    assert.deepEqual(order, ["one", "archived", "two"]);
  }
});

test("empty active lists retain all archived projects and accept only an empty request", () => {
  assert.deepEqual(applyActiveProjectOrder(["archived"], [], []), ["archived"]);
  assert.deepEqual(applyActiveProjectOrder([], [], []), []);
  assert.equal(applyActiveProjectOrder(["archived"], [], ["archived"]), null);
});

test("applying an order never mutates any of its inputs", () => {
  const order = Object.freeze(["one", "archived", "two"]);
  const active = Object.freeze(["one", "two"]);
  const requested = Object.freeze(["two", "one"]);
  assert.deepEqual(applyActiveProjectOrder(order, active, requested), ["two", "archived", "one"]);
  assert.deepEqual(order, ["one", "archived", "two"]);
  assert.deepEqual(active, ["one", "two"]);
  assert.deepEqual(requested, ["two", "one"]);
});

test("large lists reconcile and reorder without losing projects or archived positions", () => {
  const keys = Array.from({ length: 10_000 }, (_, index) => `project-${index}`);
  const reconciled = reconcileProjectOrder(keys, [...keys.slice(500).reverse(), "removed", keys[500]]);
  assert.equal(reconciled.length, keys.length);
  assert.equal(new Set(reconciled).size, keys.length);
  assert.deepEqual(reconciled.slice(-500), keys.slice(0, 500));
  const active = keys.filter((_, index) => index % 2 === 0);
  const result = applyActiveProjectOrder(keys, active, [...active].reverse());
  assert.ok(result);
  assert.deepEqual(result.filter((_, index) => index % 2 !== 0), keys.filter((_, index) => index % 2 !== 0));
  assert.deepEqual(result.filter((_, index) => index % 2 === 0), [...active].reverse());
});
