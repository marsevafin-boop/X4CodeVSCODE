import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-compact-mode-"));
after(async () => rm(temp, { recursive: true, force: true }));
const outfile = join(temp, "compact.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/compactMode.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
const { CompactModeController } = await import(process.env.AGENT_HUB_COMPACT_DIRECT_SOURCE === "1"
  ? new URL("../src/compactMode.ts", import.meta.url).href : pathToFileURL(outfile).href);

function fixture({ saved = false, centered = true } = {}) {
  const h = { saved, centered, commands: [], writes: [], states: [], failures: new Map() };
  h.fail = (command, count = 1) => h.failures.set(command, count);
  h.controller = new CompactModeController({
    readEnabled: () => h.saved,
    writeEnabled: async (enabled) => { h.writes.push(enabled); if (h.failures.get("save")) { h.failures.set("save", h.failures.get("save") - 1); throw new Error("save failed"); } h.saved = enabled; },
    executeCommand: async (id) => { h.commands.push(id); if (h.block) await h.block(id); if (h.failures.get(id)) { h.failures.set(id, h.failures.get(id) - 1); throw new Error(`${id} failed`); } },
    centersLayout: () => h.centered,
    publish: (state) => h.states.push({ ...state }),
  });
  h.owner = {};
  return h;
}
const nativeEnter = ["workbench.action.exitZenMode", "workbench.action.toggleZenMode", "workbench.action.toggleCenteredLayout"];

test("compact mode defaults to an idle disabled state without touching native layout or settings", async () => {
  const h = fixture(); await h.controller.attach(h.owner);
  assert.deepEqual(h.controller.state, { enabled: false, pending: false });
  assert.deepEqual(h.commands, []); assert.deepEqual(h.writes, []);
});
test("enabling deterministically enters Zen, reclaims centered margins and saves only its preference", async () => {
  const h = fixture(); await h.controller.attach(h.owner); await h.controller.setEnabled(true);
  assert.deepEqual(h.commands, nativeEnter); assert.deepEqual(h.writes, [true]);
  assert.deepEqual(h.controller.state, { enabled: true, pending: false });
  assert.ok(h.states.some((state) => state.pending));
});
test("existing user preference without Zen centering avoids toggling centered layout on", async () => {
  const h = fixture({ centered: false }); await h.controller.attach(h.owner); await h.controller.setEnabled(true);
  assert.deepEqual(h.commands, nativeEnter.slice(0, 2));
});
test("repeat enable and ready attach to the same panel never toggle the mode back off", async () => {
  const h = fixture(); await h.controller.attach(h.owner); await h.controller.setEnabled(true);
  await Promise.all([h.controller.setEnabled(true), h.controller.attach(h.owner), h.controller.setEnabled(true)]);
  assert.deepEqual(h.commands, nativeEnter); assert.deepEqual(h.writes, [true]);
});
test("disabling exits idempotently and records the disabled preference", async () => {
  const h = fixture({ saved: true }); await h.controller.attach(h.owner); h.commands = [];
  await h.controller.setEnabled(false); await h.controller.setEnabled(false);
  assert.deepEqual(h.commands, ["workbench.action.exitZenMode"]);
  assert.deepEqual(h.writes, [false]); assert.deepEqual(h.controller.state, { enabled: false, pending: false });
});
test("saved mode restores once for each newly attached multichat panel", async () => {
  const h = fixture({ saved: true }); await h.controller.attach(h.owner); await h.controller.attach(h.owner);
  assert.deepEqual(h.commands, nativeEnter); assert.deepEqual(h.writes, []);
  await h.controller.detach(h.owner); await h.controller.attach({});
  assert.deepEqual(h.commands, [...nativeEnter, "workbench.action.exitZenMode", ...nativeEnter]);
  assert.equal(h.saved, true);
});
test("closing compact multichat restores native bars while keeping the restore preference", async () => {
  const h = fixture({ saved: true }); await h.controller.attach(h.owner); h.commands = [];
  await h.controller.detach(h.owner);
  assert.deepEqual(h.commands, ["workbench.action.exitZenMode"]); assert.deepEqual(h.writes, []); assert.equal(h.saved, true);
});
test("closing a different panel cannot restore or change the active board", async () => {
  const h = fixture({ saved: true }); await h.controller.attach(h.owner); h.commands = [];
  await h.controller.detach({}); assert.deepEqual(h.commands, []); assert.equal(h.saved, true);
});
test("rapid close and reopen never executes a stale close after the new panel enters Zen", async () => {
  const h = fixture({ saved: true }); await h.controller.attach(h.owner); h.commands = [];
  const closed = h.controller.detach(h.owner); const opened = h.controller.attach({}); await Promise.all([closed, opened]);
  assert.deepEqual(h.commands, nativeEnter); assert.deepEqual(h.controller.state, { enabled: true, pending: false });
});
test("queued attachment of a disposed panel is skipped before native work", async () => {
  const h = fixture({ saved: true }); const stale = h.controller.attach(h.owner); const closed = h.controller.detach(h.owner); const opened = h.controller.attach({});
  await Promise.all([stale, closed, opened]); assert.deepEqual(h.commands, nativeEnter);
});
test("native transitions are serialized separately from unrelated work", async () => {
  const h = fixture(); await h.controller.attach(h.owner); let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  h.block = async (id) => { if (id === "workbench.action.toggleZenMode") await blocked; };
  const enabling = h.controller.setEnabled(true); const disabling = h.controller.setEnabled(false);
  await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(h.commands, nativeEnter.slice(0, 2));
  release(); await Promise.all([enabling, disabling]);
  assert.deepEqual(h.commands, [...nativeEnter, "workbench.action.exitZenMode"]); assert.equal(h.saved, false);
});
test("failed initial exit leaves the mode disabled with an actionable final error", async () => {
  const h = fixture(); await h.controller.attach(h.owner); h.fail("workbench.action.exitZenMode"); await h.controller.setEnabled(true);
  assert.equal(h.controller.state.enabled, false); assert.equal(h.controller.state.pending, false); assert.match(h.controller.state.error, /exitZenMode/); assert.equal(h.saved, false);
});
test("failed native entering rolls back without saving an enabled preference", async () => {
  const h = fixture(); await h.controller.attach(h.owner); h.fail("workbench.action.toggleZenMode"); await h.controller.setEnabled(true);
  assert.deepEqual(h.commands, [...nativeEnter.slice(0, 2), "workbench.action.exitZenMode"]);
  assert.equal(h.controller.state.enabled, false); assert.equal(h.controller.state.pending, false); assert.equal(h.saved, false);
});
test("failed margin reclaim also exits Zen before reporting disabled", async () => {
  const h = fixture(); await h.controller.attach(h.owner); h.fail("workbench.action.toggleCenteredLayout"); await h.controller.setEnabled(true);
  assert.deepEqual(h.commands, [...nativeEnter, "workbench.action.exitZenMode"]); assert.equal(h.saved, false); assert.equal(h.controller.state.enabled, false);
});
test("failed native exit retains enabled density and preference for retry", async () => {
  const h = fixture({ saved: true }); await h.controller.attach(h.owner); h.fail("workbench.action.exitZenMode"); await h.controller.setEnabled(false);
  assert.equal(h.saved, true); assert.equal(h.controller.state.enabled, true); assert.equal(h.controller.state.pending, false); assert.match(h.controller.state.error, /exitZenMode/);
  await h.controller.setEnabled(false); assert.equal(h.controller.state.enabled, false); assert.equal(h.saved, false); assert.equal(h.controller.state.error, undefined);
});
test("save failure on enable returns native layout to its original disabled state", async () => {
  const h = fixture(); await h.controller.attach(h.owner); h.fail("save"); await h.controller.setEnabled(true);
  assert.deepEqual(h.commands, [...nativeEnter, "workbench.action.exitZenMode"]); assert.equal(h.saved, false); assert.equal(h.controller.state.enabled, false); assert.match(h.controller.state.error, /save failed/);
});
test("save failure on disable restores compact native state to match its retained preference", async () => {
  const h = fixture({ saved: true }); await h.controller.attach(h.owner); h.commands = []; h.fail("save"); await h.controller.setEnabled(false);
  assert.deepEqual(h.commands, ["workbench.action.exitZenMode", ...nativeEnter]); assert.equal(h.saved, true); assert.equal(h.controller.state.enabled, true); assert.match(h.controller.state.error, /save failed/);
});
test("failed rollback keeps enabled controls available instead of falsely reporting native exit", async () => {
  const h = fixture(); await h.controller.attach(h.owner); h.fail("save"); let exits = 0;
  h.block = async (id) => { if (id === "workbench.action.exitZenMode" && ++exits === 2) h.fail(id); };
  await h.controller.setEnabled(true);
  assert.equal(h.controller.state.enabled, true); assert.equal(h.controller.state.pending, false); assert.match(h.controller.state.error, /exitZenMode/);
  h.block = undefined; await h.controller.setEnabled(false); assert.equal(h.controller.state.enabled, false);
});
test("saved restore failure retains the preference and clears pending so the user can retry or exit", async () => {
  const h = fixture({ saved: true }); h.fail("workbench.action.toggleZenMode"); await h.controller.attach(h.owner);
  assert.equal(h.saved, true); assert.equal(h.controller.state.enabled, true); assert.equal(h.controller.state.pending, false); assert.match(h.controller.state.error, /toggleZenMode/);
  await h.controller.setEnabled(true); assert.equal(h.controller.state.error, undefined);
});
test("detached enable request cannot change the reopened board's native layout", async () => {
  const h = fixture(); await h.controller.attach(h.owner); const pending = h.controller.setEnabled(true); const close = h.controller.detach(h.owner); const reopen = h.controller.attach({});
  await Promise.all([pending, close, reopen]); assert.deepEqual(h.commands, []); assert.equal(h.saved, false);
});

test("two rapid palette toggles preserve both intentions in their serialized order", async () => {
  const h = fixture(); await h.controller.attach(h.owner);
  await Promise.all([h.controller.toggle(), h.controller.toggle()]);
  assert.deepEqual(h.commands, [...nativeEnter, "workbench.action.exitZenMode"]);
  assert.deepEqual(h.writes, [true, false]); assert.equal(h.controller.state.enabled, false);
});
test("closing after a failed saved restore still publishes owner removal for native context cleanup", async () => {
  const h = fixture({ saved: true }); h.fail("workbench.action.toggleZenMode"); await h.controller.attach(h.owner); h.states = [];
  await h.controller.detach(h.owner); assert.equal(h.states.length, 1); assert.equal(h.states[0].pending, false);
});

test("enabling without an attached owner cannot enter native mode or persist a preference", async () => {
  const h = fixture(); await h.controller.setEnabled(true); await h.controller.toggle();
  assert.deepEqual(h.commands, []); assert.deepEqual(h.writes, []); assert.equal(h.controller.state.enabled, false);
});
