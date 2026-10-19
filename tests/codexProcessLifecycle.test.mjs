import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn as spawnHarmlessChild } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-process-test-"));
const mockKey = Symbol.for("agent-hub.codex-process-tests");
let spawned;
let spawnCount = 0;
globalThis[mockKey] = { spawn: () => { spawnCount++; return spawned; } };
after(async () => {
  delete globalThis[mockKey];
  await rm(temp, { recursive: true, force: true });
});
const outfile = join(temp, "backend.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/agents/codexBackend.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{
    name: "mock-spawn",
    setup(b) {
      b.onResolve({ filter: /^node:child_process$/ }, ({ path }) => ({ path, namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
        contents: 'export const spawn = (...args) => globalThis[Symbol.for("agent-hub.codex-process-tests")].spawn(...args);',
      }));
    },
  }],
});
const backend = await import(pathToFileURL(outfile).href);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const timings = { termTimeoutMs: 10, killTimeoutMs: 10 };
let nextPid = 9_000_000;

function child(t, onSignal = () => {}) {
  const c = new EventEmitter();
  c.pid = nextPid++;
  c.exitCode = null;
  c.signalCode = null;
  c.signals = [];
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = new PassThrough();
  c.kill = (signal) => {
    c.signals.push(signal);
    onSignal(signal, c);
    return true;
  };
  c.exit = (code = null, signal = "SIGTERM") => {
    c.exitCode = code;
    c.signalCode = signal;
    c.emit("exit", code, signal);
  };
  // Fake children only: never send a signal to any host or external PID.
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    assert.equal(pid, -c.pid);
    return c.kill(signal);
  };
  t.after(() => { process.kill = originalKill; c.exit(); });
  return c;
}

test("a signalled exit is already stopped and is never signalled again", async (t) => {
  const c = child(t);
  c.signalCode = "SIGKILL";
  assert.equal(await backend.stopCodex(c, timings), true);
  backend.hardKill(c);
  assert.deepEqual(c.signals, []);
});

test("stop waits for actual exit after TERM instead of claiming the writer is free", async (t) => {
  const c = child(t);
  let done = false;
  const stopped = backend.stopCodex(c, { ...timings, termTimeoutMs: 100 }).then((ok) => { done = true; return ok; });
  await tick();
  assert.equal(done, false);
  assert.deepEqual(c.signals, ["SIGTERM"]);
  c.exit();
  assert.equal(await stopped, true);
  assert.equal(c.listenerCount("exit"), 0);
});

test("TERM timeout escalates once and waits for KILL exit", async (t) => {
  const c = child(t, (signal, process) => {
    if (signal === "SIGKILL") setImmediate(() => process.exit(null, signal));
  });
  const first = backend.stopCodex(c, timings);
  const second = backend.stopCodex(c, timings);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(c.signals, ["SIGTERM", "SIGKILL"]);
});

test("bounded failure retains a thread owner for the next cleanup attempt", async (t) => {
  const c = child(t);
  backend.trackCodex("blocked", c);
  assert.equal(await backend.stopStaleCodex("blocked", timings), false);
  assert.deepEqual(c.signals, ["SIGTERM", "SIGKILL"]);
  c.signals.length = 0;
  assert.equal(await backend.stopStaleCodex("blocked", timings), false);
  assert.deepEqual(c.signals, ["SIGTERM", "SIGKILL"]);
  c.exit();
  assert.equal(await backend.stopStaleCodex("blocked", timings), true);
  assert.equal(c.listenerCount("exit"), 0);
});

test("signal-exited stale owners are removed without trying to kill them", async (t) => {
  const c = child(t);
  backend.trackCodex("signalled", c);
  c.signalCode = "SIGKILL";
  assert.equal(await backend.stopStaleCodex("signalled", timings), true);
  assert.equal(backend.killStaleCodex("signalled"), false);
  assert.deepEqual(c.signals, []);
});

test("extension unload includes an owned process before its thread handshake", (t) => {
  const c = child(t, (signal, process) => process.exit(null, signal));
  backend.trackCodexProcess(c);
  backend.killAllCodex();
  backend.killAllCodex();
  assert.deepEqual(c.signals, ["SIGKILL"]);
  assert.equal(c.listenerCount("exit"), 0);
});

test("exec generator cleanup waits for child exit when the consumer leaves early", async (t) => {
  const c = child(t);
  spawned = c;
  const run = new backend.CodexBackend().start("work", {
    cwd: temp, config: { contextWindow: 0 }, signal: new AbortController().signal,
  });
  const first = run.next();
  c.stdout.write('{"type":"turn.started"}\n');
  assert.deepEqual((await first).value, { kind: "activity", label: "Думает…" });
  let done = false;
  const returned = run.return().then(() => { done = true; });
  await tick();
  assert.equal(done, false);
  assert.deepEqual(c.signals, ["SIGTERM"]);
  c.exit();
  await returned;
  assert.equal(done, true);
});

test("exec consumes an already emitted close without hanging", async (t) => {
  const c = child(t);
  spawned = c;
  const run = (async () => {
    const events = [];
    for await (const event of new backend.CodexBackend().start("work", {
      cwd: temp, config: { contextWindow: 0 }, signal: new AbortController().signal,
    })) events.push(event);
    return events;
  })();
  c.exit(1, null);
  c.emit("close", 1, null);
  c.stdout.end();
  const result = await Promise.race([run, new Promise((resolve) => setTimeout(() => resolve("hung"), 100))]);
  assert.notEqual(result, "hung");
  assert.equal(result.at(-1).kind, "result");
  assert.equal(result.at(-1).ok, false);
});

test("cleanup cannot report a free thread if another owner replaced it while waiting", async (t) => {
  const c = child(t);
  backend.trackCodex("replaced", c);
  const stopped = backend.stopStaleCodex("replaced", { ...timings, termTimeoutMs: 100 });
  const replacement = new EventEmitter();
  replacement.exitCode = null;
  replacement.signalCode = null;
  backend.trackCodex("replaced", replacement);
  c.exit();
  assert.equal(await stopped, false);
  replacement.exitCode = 0;
  replacement.emit("exit", 0);
  assert.equal(await backend.stopStaleCodex("replaced", timings), true);
});


test("legacy stale kill keeps ownership until exit is observed", async (t) => {
  const c = child(t);
  backend.trackCodex("legacy", c);
  assert.equal(backend.killStaleCodex("legacy"), true);
  let done = false;
  const stopped = backend.stopStaleCodex("legacy", { ...timings, termTimeoutMs: 100 }).then((ok) => {
    done = true;
    return ok;
  });
  await tick();
  assert.equal(done, false);
  c.exit(null, "SIGKILL");
  assert.equal(await stopped, true);
  assert.equal(backend.killStaleCodex("legacy"), false);
});

test("actual owned Node process exits before stopCodex confirms release", async (t) => {
  // Harmless local child: no Codex/model, files, network, or external PID lookup.
  const c = spawnHarmlessChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32", stdio: "ignore",
  });
  t.after(() => { if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); });
  backend.trackCodex("real-harmless-child", c);
  assert.equal(await backend.stopCodex(c, { termTimeoutMs: 1000, killTimeoutMs: 1000 }), true);
  assert.ok(c.exitCode !== null || c.signalCode !== null);
  assert.equal(await backend.stopStaleCodex("real-harmless-child", timings), true);
  backend.killAllCodex();
});


for (const preCancelled of [true, false]) {
  test(`exec cancellation ${preCancelled ? "before" : "during"} stale cleanup cannot spawn or send a prompt`, async (t) => {
    const c = child(t);
    spawned = c;
    backend.trackCodex("cancel-cleanup", c);
    const abort = new AbortController();
    if (preCancelled) abort.abort();
    const before = spawnCount;
    const run = (async () => {
      const events = [];
      for await (const event of new backend.CodexBackend().start("never send", {
        cwd: temp, config: { contextWindow: 0 }, signal: abort.signal,
        resumeSessionId: "cancel-cleanup",
      })) events.push(event);
      return events;
    })();
    await tick();
    if (!preCancelled) assert.deepEqual(c.signals, ["SIGTERM"]);
    const initialSignals = [...c.signals];
    abort.abort();
    c.exit();
    await tick();
    c.stdout.end();
    c.emit("close", 0);
    await run;
    assert.equal(spawnCount, before, "cancelled request must not start another Codex");
    assert.equal(c.stdin.read(), null, "cancelled request must not send task text");
    if (preCancelled) assert.deepEqual(initialSignals, [], "cancelled request must not stop another writer");
  });
}

for (const execution of [
  { type: "turn.started" },
  { type: "item.started", item: { id: "cmd", type: "command_execution", command: "work" } },
  { type: "item.completed", item: { id: "answer", type: "agent_message", text: "Already acted" } },
  { type: "item.updated", item: { id: "new-kind" } },
]) {
  test(`writer text after ${execution.type} is never marked safe for task replay`, async (t) => {
    const c = child(t);
    spawned = c;
    const run = (async () => {
      const events = [];
      for await (const event of new backend.CodexBackend().start("work", {
        cwd: temp, config: { contextWindow: 0 }, signal: new AbortController().signal,
        resumeSessionId: "writer-after-execution",
      })) events.push(event);
      return events;
    })();
    await tick();
    c.stdout.write(JSON.stringify(execution) + "\n");
    await tick();
    c.stderr.write("thread already has an active writer");
    c.exit(1, null);
    c.emit("close", 1);
    c.stdout.end();
    const events = await run;
    assert.equal(events.some((event) => event.code === "codexWriterConflict"), false);
    assert.equal(events.some((event) => event.kind === "error" && /active writer/.test(event.message)), true);
    assert.deepEqual(events.at(-1).kind, "result");
    assert.equal(events.at(-1).ok, false);
  });
}

test("initial exec resume writer conflict remains recoverable before any execution event", async (t) => {
  const c = child(t);
  spawned = c;
  const run = (async () => {
    const events = [];
    for await (const event of new backend.CodexBackend().start("work", {
      cwd: temp, config: { contextWindow: 0 }, signal: new AbortController().signal,
      resumeSessionId: "initial-conflict",
    })) events.push(event);
    return events;
  })();
  await tick();
  c.stderr.write("thread already has an active writer");
  c.exit(1, null);
  c.emit("close", 1);
  c.stdout.end();
  const events = await run;
  assert.equal(events.filter((event) => event.code === "codexWriterConflict").length, 1);
});
