import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-writer-recovery-"));
after(() => rm(temp, { recursive: true, force: true }));
const outfile = join(temp, "recovery.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/agents/codexWriterRecovery.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
});
const { CodexWriterRecoveryBackend } = await import(pathToFileURL(outfile).href);

const conflict = { kind: "error", code: "codexWriterConflict", message: "writer held", threadId: "original" };
const failed = { kind: "result", ok: false };
const success = { kind: "result", ok: true };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const collect = async (stream) => {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
};
function fakeBackend(events, cleanup = async () => {}) {
  return {
    id: "codex", calls: [],
    async *start(prompt, opts) {
      this.calls.push({ prompt, opts });
      try { yield* events; } finally { await cleanup(); }
    },
  };
}
function options() {
  const controller = new AbortController();
  const opts = {
    cwd: "/project", resumeSessionId: "original", signal: controller.signal,
    config: { contextWindow: 123, model: "test-model", effort: "high", sandbox: "read-only" },
    attachments: [{ path: "/image.png", isImage: true }], steer: {},
    confirmTool: async () => ({ allow: false }),
  };
  return { controller, opts };
}

test("typed pre-task exec conflict switches once with identical prompt and options", async () => {
  const primary = fakeBackend([{ kind: "session", sessionId: "original" }, conflict, failed]);
  const fallback = fakeBackend([{ kind: "session", sessionId: "fork" }, { kind: "assistantText", text: "Final" }, success]);
  const { opts } = options();
  const wrapper = new CodexWriterRecoveryBackend(primary, fallback);
  assert.equal(wrapper.id, "codex");
  const prompt = "Задача ✅\nwith attachments";
  const events = await collect(wrapper.start(prompt, opts));
  assert.equal(primary.calls.length, 1);
  assert.equal(fallback.calls.length, 1);
  assert.strictEqual(primary.calls[0].opts, opts);
  assert.strictEqual(fallback.calls[0].opts, opts);
  assert.equal(fallback.calls[0].prompt, prompt);
  assert.equal(events.some((e) => e.kind === "error"), false);
  assert.deepEqual(events.filter((e) => e.kind === "result"), [success]);
  assert.match(events.find((e) => e.kind === "notice").text, /app.server/iu);
  assert.equal(events.at(-2).text, "Final");
});

test("app-server waits for complete primary generator cleanup before starting", async () => {
  let release;
  let cleaning = false;
  const cleanup = new Promise((resolve) => { release = resolve; });
  const primary = fakeBackend([conflict, failed], () => { cleaning = true; return cleanup; });
  const fallback = fakeBackend([success]);
  const { opts } = options();
  const run = collect(new CodexWriterRecoveryBackend(primary, fallback).start("task", opts));
  await tick();
  assert.equal(cleaning, true);
  assert.equal(fallback.calls.length, 0);
  release();
  await run;
  assert.equal(fallback.calls.length, 1);
});

test("abort during deferred primary cleanup prevents recovery", async () => {
  let release;
  const cleanup = new Promise((resolve) => { release = resolve; });
  const primary = fakeBackend([conflict, failed], () => cleanup);
  const fallback = fakeBackend([success]);
  const { opts, controller } = options();
  const run = collect(new CodexWriterRecoveryBackend(primary, fallback).start("task", opts));
  await tick();
  controller.abort();
  release();
  const events = await run;
  assert.equal(fallback.calls.length, 0);
  assert.deepEqual(events, []);
});

test("abort after the switching notice prevents app-server start", async () => {
  const primary = fakeBackend([conflict, failed]);
  const fallback = fakeBackend([success]);
  const { opts, controller } = options();
  const stream = new CodexWriterRecoveryBackend(primary, fallback).start("task", opts)[Symbol.asyncIterator]();
  const notice = await stream.next();
  assert.equal(notice.value?.kind, "notice");
  assert.equal(fallback.calls.length, 0);
  controller.abort();
  assert.equal((await stream.next()).done, true);
  assert.equal(fallback.calls.length, 0);
});

test("non-conflict failures and raw conflict-like text pass through without retry", async () => {
  const error = { kind: "error", message: "thread-store conflict in untyped diagnostic" };
  const primary = fakeBackend([error, failed]);
  const fallback = fakeBackend([success]);
  const { opts } = options();
  assert.deepEqual(await collect(new CodexWriterRecoveryBackend(primary, fallback).start("task", opts)), [error, failed]);
  assert.equal(fallback.calls.length, 0);
});

for (const output of [
  { kind: "textDelta", text: "partial" },
  { kind: "assistantText", text: "partial" },
  { kind: "toolUse", toolName: "Bash", summary: "ran command" },
  { kind: "question", id: "q", questions: [{ title: "Continue?", options: [] }] },
]) {
  test(`${output.kind} before a writer conflict forbids replay and preserves failure`, async () => {
    const events = [output, conflict, failed];
    const primary = fakeBackend(events);
    const fallback = fakeBackend([success]);
    const { opts } = options();
    assert.deepEqual(await collect(new CodexWriterRecoveryBackend(primary, fallback).start("task", opts)), events);
    assert.equal(fallback.calls.length, 0);
  });
}

test("primary cleanup failure propagates and forbids app-server recovery", async () => {
  const error = new Error("cleanup failed");
  const primary = fakeBackend([conflict, failed], async () => { throw error; });
  const fallback = fakeBackend([success]);
  const { opts } = options();
  await assert.rejects(collect(new CodexWriterRecoveryBackend(primary, fallback).start("task", opts)), (e) => e === error);
  assert.equal(fallback.calls.length, 0);
});

test("an app-server writer conflict passes through once without recursive recovery", async () => {
  const primary = fakeBackend([conflict, failed]);
  const fallback = fakeBackend([conflict, failed]);
  const { opts } = options();
  const events = await collect(new CodexWriterRecoveryBackend(primary, fallback).start("task", opts));
  assert.equal(fallback.calls.length, 1);
  assert.deepEqual(events.slice(-2), [conflict, failed]);
});

test("a successful exec run passes through without app-server", async () => {
  const events = [{ kind: "assistantText", text: "done" }, success];
  const primary = fakeBackend(events);
  const fallback = fakeBackend([success]);
  const { opts } = options();
  assert.deepEqual(await collect(new CodexWriterRecoveryBackend(primary, fallback).start("task", opts)), events);
  assert.equal(fallback.calls.length, 0);
});
