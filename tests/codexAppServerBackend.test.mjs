import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

// Bundle the actual backend with module-level process mocks. No source rewriting,
// real Codex processes, VS Code, network calls, or additional test dependencies.
const temp = await mkdtemp(join(tmpdir(), "agent-hub-backend-test-"));
const mockKey = Symbol.for("agent-hub.codex-backend-tests");
let current;
globalThis[mockKey] = {
  spawn: (...args) => {
    current.spawnArgs = args;
    return current.child;
  },
  execStart: (prompt, opts) => current.execCalls.push({ prompt, resumeSessionId: opts.resumeSessionId }),
  hardKill: (child) => {
    const h = child.harness;
    if (child.exitCode !== null || child.signalCode != null) return;
    h.kills++;
    child.exitCode = 0;
    child.emit("exit", 0);
  },
  stopCodex: async (child) => {
    const h = child.harness;
    if (h.stop) return h.stop(child);
    globalThis[mockKey].hardKill(child);
    return true;
  },
  stopStaleCodex: async () => current.staleCleanup,
  trackCodexProcess: (child) => current.processTracking.push({ child, writesAtTracking: current.writes.length }),
};
after(async () => {
  delete globalThis[mockKey];
  await rm(temp, { recursive: true, force: true });
});
const outfile = join(temp, "backend.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/agents/codexAppServerBackend.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [{
    name: "mock-codex-process",
    setup(b) {
      b.onResolve({ filter: /^node:child_process$|^\.\/codexBackend$/ }, ({ path }) => ({ path, namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
        contents: path === "node:child_process"
          ? 'export const spawn = (...args) => globalThis[Symbol.for("agent-hub.codex-backend-tests")].spawn(...args);'
          : `export class CodexBackend { async *start(prompt, opts) {
               globalThis[Symbol.for("agent-hub.codex-backend-tests")].execStart(prompt, opts);
               yield { kind: "notice", text: "mock exec fallback" };
               yield { kind: "result", ok: true };
             } }
             export const WRITER_CONFLICT_RE = /thread-store conflict/;
             export const codexDefaultModel = () => "test-model";
             export const hardKill = (child) => globalThis[Symbol.for("agent-hub.codex-backend-tests")].hardKill(child);
             export const stopCodex = (child) => globalThis[Symbol.for("agent-hub.codex-backend-tests")].stopCodex(child);
             export const stopStaleCodex = () => globalThis[Symbol.for("agent-hub.codex-backend-tests")].stopStaleCodex();
             export const trackCodexProcess = (child) => globalThis[Symbol.for("agent-hub.codex-backend-tests")].trackCodexProcess(child);
             export const killStaleCodex = () => false;
             export const trackCodex = () => {};
             export const untrackCodex = () => {};`,
      }));
    },
  }],
});
const { CodexAppServerBackend } = await import(pathToFileURL(outfile).href);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition) {
  for (let i = 0; i < 50; i++) {
    if (condition()) return;
    await tick();
  }
  assert.fail("mock app-server did not reach the expected state");
}

async function launch(t, { resume = false, start = true, waitFor = "turn", onThread, onEvent, config = {}, attachments, staleCleanup = true } = {}) {
  const h = {
    child: new EventEmitter(), writes: [], events: [], confirms: [], execCalls: [], processTracking: [], kills: 0, staleCleanup,
    done: false, thread: resume ? "resumed-main" : "main", turn: "main-turn", steer: {}, abort: new AbortController(),
  };
  current = h;
  h.child.harness = h;
  h.child.stdout = new PassThrough();
  h.child.stderr = new PassThrough();
  h.child.exitCode = null;
  h.send = (message) => h.child.stdout.write(JSON.stringify(message) + "\n");
  h.notify = (method, params) => h.send({ method, params });
  h.reply = (request, result) => h.send({ id: request.id, result });
  h.child.stdin = new Writable({
    write(chunk, encoding, callback) {
      const m = JSON.parse(chunk.toString());
      h.writes.push(m);
      if (m.method === "initialize") h.reply(m, {});
      if (["thread/start", "thread/resume", "thread/fork"].includes(m.method)) {
        if (onThread) onThread(m, h);
        else h.reply(m, { thread: { id: h.thread }, model: "test-model" });
      }
      if (m.method === "turn/steer" || m.method === "turn/interrupt") h.reply(m, {});
      callback();
    },
  });
  h.turnRequests = () => h.writes.filter((m) => m.method === "turn/start");
  h.scope = (turn = h.turn) => ({ threadId: h.thread, turnId: turn });
  h.complete = (id = h.turn, status = "completed", threadId = h.thread) =>
    h.notify("turn/completed", { threadId, turn: { id, status, items: [], error: null } });
  h.acceptStart = (request = h.turnRequests().at(-1), id = h.turn) =>
    h.reply(request, { turn: { id, status: "inProgress", items: [] } });
  h.run = (async () => {
    for await (const event of new CodexAppServerBackend().start("work", {
      cwd: temp, config: { contextWindow: 0, ...config }, signal: h.abort.signal, attachments,
      steer: h.steer, ...(resume ? { resumeSessionId: h.thread } : {}),
      confirmTool: (...args) => {
        h.confirms.push(args);
        if (h.confirm) return h.confirm(...args);
        return Promise.resolve({ allow: true, answer: "answer" });
      },
    })) {
      h.events.push(event);
      onEvent?.(event, h);
    }
    h.done = true;
  })();
  t.after(async () => {
    h.releaseCleanup?.();
    h.complete();
    if (h.turnRequests().length > 0) h.acceptStart();
    await tick();
    if (!h.done) h.child.emit("exit", 0);
    await h.run;
  });
  await until(() => waitFor === "done" ? h.done : waitFor === "thread"
    ? h.writes.some((m) => m.method === "thread/start" || m.method === "thread/resume")
    : h.turnRequests().length === 1 || h.done);
  if (start) {
    assert.equal(h.turnRequests().length, 1, "backend must start the requested task");
    h.acceptStart();
    await until(() => h.steer.handler);
    h.notify("turn/started", { threadId: h.thread, turn: { id: h.turn, status: "inProgress", items: [] } });
    await tick();
  }
  return h;
}

test("child completion leaves the generator and process alive until the main final answer", async (t) => {
  const h = await launch(t);
  h.notify("turn/started", { threadId: "child", turn: { id: "child-turn" } });
  h.complete("child-turn", "completed", "child");
  await tick();
  assert.equal(h.done, false, "child completion must not finish the main generator");
  assert.equal(h.kills, 0, "child completion must not kill app-server");
  assert.equal(h.events.some((e) => e.kind === "result"), false);
  h.notify("item/completed", { ...h.scope(), item: { id: "final", type: "agentMessage", text: "Итог ✅" } });
  h.complete();
  await h.run;
  assert.deepEqual(h.events.filter((e) => e.kind === "assistantText"), [{ kind: "assistantText", text: "Итог ✅" }]);
  assert.equal(h.events.filter((e) => e.kind === "result").length, 1);
  assert.equal(h.events.at(-1).ok, true);
  assert.equal(h.kills, 1);
});

test("foreign and unscoped notifications cannot alter text, context, errors, model or activity", async (t) => {
  const h = await launch(t);
  const before = structuredClone(h.events);
  for (const threadId of ["child", undefined, null, 42, ""]) {
    const scope = { threadId, turnId: h.turn };
    h.notify("turn/started", { threadId, turn: { id: "foreign" } });
    h.notify("item/started", { ...scope, item: { id: "same", type: "commandExecution", command: "child command" } });
    h.notify("item/agentMessage/delta", { ...scope, itemId: "answer", delta: "child text" });
    h.notify("item/completed", { ...scope, item: { id: "child-answer", type: "agentMessage", text: "child final" } });
    h.notify("thread/tokenUsage/updated", { ...scope, tokenUsage: { last: { totalTokens: 999 } } });
    h.notify("model/rerouted", { ...scope, fromModel: "one", toModel: "foreign-model" });
    h.notify("error", { ...scope, error: { message: "foreign error" } });
    h.notify("thread/compacted", scope);
  }
  await tick();
  assert.deepEqual(h.events, before);
  h.notify("item/started", { ...h.scope(), item: { id: "same", type: "subAgentActivity", agentPath: "/root/reviewer", kind: "completed" } });
  h.notify("item/agentMessage/delta", { ...h.scope(), itemId: "answer", delta: "main text" });
  await tick();
  assert.equal(h.events.some((e) => e.kind === "toolUse" && e.toolName === "subAgentActivity"), true);
  assert.deepEqual(h.events.filter((e) => e.kind === "textDelta"), [{ kind: "textDelta", text: "\n\n" }, { kind: "textDelta", text: "main text" }]);
  assert.equal(h.done, false);
});

test("a different main-thread turn cannot replace the active turn or complete it", async (t) => {
  const h = await launch(t);
  h.notify("turn/started", { threadId: h.thread, turn: { id: "old-turn" } });
  h.notify("item/agentMessage/delta", { ...h.scope("old-turn"), itemId: "old", delta: "old text" });
  h.complete("old-turn");
  h.notify("turn/completed", { threadId: h.thread, turn: { status: "completed" } });
  await tick();
  assert.equal(h.done, false);
  await h.steer.handler("уточнение", "next");
  assert.deepEqual(h.writes.find((m) => m.method === "turn/steer").params, {
    threadId: h.thread, expectedTurnId: h.turn, input: [{ type: "text", text: "уточнение" }],
  });
  assert.equal(h.events.some((e) => e.kind === "textDelta"), false);
});

test("early notifications are matched against turn/start response before they are emitted", async (t) => {
  const h = await launch(t, { start: false, resume: true });
  h.complete("old-turn");
  h.notify("turn/started", { threadId: h.thread, turn: { id: h.turn } });
  h.notify("item/agentMessage/delta", { ...h.scope(), itemId: "early", delta: "early answer" });
  h.complete();
  await tick();
  assert.equal(h.done, false);
  assert.equal(h.kills, 0);
  h.acceptStart();
  await h.run;
  assert.deepEqual(h.events.filter((e) => e.kind === "textDelta"), [{ kind: "textDelta", text: "early answer" }]);
  assert.equal(h.events.at(-1).ok, true);
  assert.equal(h.events.filter((e) => e.kind === "result").length, 1);
  assert.equal(h.writes.find((m) => m.method === "thread/resume").params.threadId, h.thread);
});

test("interrupt/restart ignores old and child events and steers the replacement main turn", async (t) => {
  const h = await launch(t);
  await h.steer.handler("new instruction", "now");
  assert.deepEqual(h.writes.find((m) => m.method === "turn/interrupt").params, h.scope());
  h.complete(h.turn, "interrupted");
  await until(() => h.turnRequests().length === 2);
  h.complete(h.turn);
  h.notify("turn/started", { threadId: "child", turn: { id: "child-turn" } });
  h.complete("child-turn", "completed", "child");
  h.turn = "replacement-turn";
  h.notify("turn/started", { threadId: h.thread, turn: { id: h.turn } });
  h.notify("item/agentMessage/delta", { ...h.scope(), itemId: "new", delta: "replacement" });
  await tick();
  await assert.rejects(h.steer.handler("too early", "next"), /ход.*(завершён|запускается)/);
  h.acceptStart();
  await tick();
  assert.equal(h.done, false);
  await h.steer.handler("follow up", "next");
  assert.equal(h.writes.find((m) => m.method === "turn/steer").params.expectedTurnId, h.turn);
  h.complete("main-turn");
  await tick();
  assert.equal(h.done, false);
  h.complete();
  await h.run;
  assert.equal(h.events.filter((e) => e.kind === "result").length, 1);
  assert.equal(h.events.at(-1).ok, true);
});

test("foreign server requests receive explicit responses without main-thread confirmation", async (t) => {
  const h = await launch(t);
  const requests = [
    ["item/commandExecution/requestApproval", { command: "child command" }],
    ["item/fileChange/requestApproval", { grantRoot: "/child" }],
    ["item/tool/requestUserInput", { questions: [{ id: "q", question: "child question" }] }],
    ["item/permissions/requestApproval", {}],
  ];
  for (const [index, [method, params]] of requests.entries()) {
    h.send({ id: 100 + index, method, params: { threadId: "child", turnId: "child-turn", ...params } });
  }
  h.send({ id: 110, method: "item/commandExecution/requestApproval", params: { ...h.scope("old-turn"), command: "stale" } });
  h.send({ id: 111, method: "item/commandExecution/requestApproval", params: { command: "unscoped" } });
  await tick();
  assert.equal(h.confirms.length, 0);
  for (const id of [100, 101, 102, 103, 110, 111]) {
    const response = h.writes.find((m) => m.id === id && !m.method);
    assert.ok(response, `server request ${id} must receive a response`);
    assert.ok(response.error || response.result?.decision === "decline" || response.result?.answers || response.result?.permissions);
  }
  h.send({ id: 120, method: "item/commandExecution/requestApproval", params: { ...h.scope(), command: "main command" } });
  await tick();
  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0][1].command, "main command");
  assert.deepEqual(h.writes.find((m) => m.id === 120).result, { decision: "accept" });
});

test("an early main server request waits for the authoritative turn/start response", async (t) => {
  const h = await launch(t, { start: false });
  h.send({ id: 101, method: "item/tool/requestUserInput", params: {
    ...h.scope(), questions: [{ id: "q", question: "main question" }],
  } });
  await tick();
  assert.equal(h.confirms.length, 0);
  h.acceptStart();
  await until(() => h.writes.some((m) => m.id === 101 && !m.method));
  assert.equal(h.confirms.length, 1);
  assert.deepEqual(h.writes.find((m) => m.id === 101).result, { answers: { q: { answers: ["answer"] } } });
});

test("main notifications retain text deduplication, questions, tools, context and reroutes", async (t) => {
  const h = await launch(t);
  h.child.stdout.write("not json\n\n");
  h.notify("item/started", { ...h.scope(), item: { id: "reason", type: "reasoning" } });
  h.notify("item/started", { ...h.scope(), item: { id: "answer", type: "agentMessage" } });
  h.notify("item/agentMessage/delta", { ...h.scope(), itemId: "answer", delta: "Ответ ✅" });
  h.notify("item/completed", { ...h.scope(), item: { id: "answer", type: "agentMessage", text: "Ответ ✅" } });
  const tool = { id: "command", type: "commandExecution", command: "git status" };
  h.notify("item/started", { ...h.scope(), item: tool });
  h.notify("item/started", { ...h.scope(), item: tool });
  h.notify("item/started", { ...h.scope(), item: { id: "compact", type: "contextCompaction" } });
  h.notify("thread/tokenUsage/updated", { ...h.scope(), tokenUsage: { last: { totalTokens: 123 }, modelContextWindow: 456 } });
  h.notify("model/rerouted", { ...h.scope(), fromModel: "test-model", toModel: "fallback-model" });
  h.notify("error", { ...h.scope(), error: { message: "retryable" }, willRetry: true });
  h.notify("thread/compacted", { threadId: h.thread });
  h.notify("item/completed", { ...h.scope(), item: { id: "question", type: "agentMessage", questions: [
    { title: "Вариант?", options: ["Первый", { label: "Второй", description: "Детали" }, { label: "" }, null] },
    { question: "Ещё?" }, null,
  ] } });
  h.complete();
  await h.run;
  assert.deepEqual(h.events.filter((e) => e.kind === "textDelta"), [{ kind: "textDelta", text: "Ответ ✅" }]);
  assert.equal(h.events.some((e) => e.kind === "assistantText"), false);
  assert.equal(h.events.filter((e) => e.kind === "toolUse").length, 1);
  assert.deepEqual(h.events.find((e) => e.kind === "contextUsage"), { kind: "contextUsage", usedTokens: 123, maxTokens: 456 });
  assert.deepEqual(h.events.find((e) => e.kind === "model" && e.fallbackFrom), {
    kind: "model", model: "fallback-model", fallbackFrom: "test-model",
  });
  assert.deepEqual(h.events.find((e) => e.kind === "question").questions, [
    { title: "Вариант?", options: [{ label: "Первый" }, { label: "Второй", description: "Детали" }] },
    { title: "Ещё?", options: [] },
  ]);
  assert.equal(h.events.some((e) => e.kind === "notice" && e.text.includes("retryable")), true);
});

test("main failed completion emits its error and one unsuccessful result", async (t) => {
  const h = await launch(t);
  h.notify("error", { ...h.scope(), error: { message: "main error" }, willRetry: false });
  h.notify("turn/completed", { threadId: h.thread, turn: { id: h.turn, status: "failed", error: { message: "failure" } } });
  await h.run;
  assert.deepEqual(h.events.filter((e) => e.kind === "error"), [
    { kind: "error", message: "main error" }, { kind: "error", message: "failure" },
  ]);
  assert.equal(h.events.filter((e) => e.kind === "result").length, 1);
  assert.equal(h.events.at(-1).ok, false);
  assert.equal(h.kills, 1);
});

test("start failure settles queued server requests and returns an unsuccessful result", async (t) => {
  const h = await launch(t, { start: false });
  h.send({ id: 100, method: "item/commandExecution/requestApproval", params: { ...h.scope(), command: "early" } });
  h.send({ id: h.turnRequests()[0].id, error: { code: -32603, message: "start failed" } });
  await h.run;
  await tick();
  assert.equal(h.confirms.length, 0);
  assert.equal(h.events.at(-1).ok, false);
  assert.equal(h.events.some((e) => e.kind === "error" && e.message.includes("start failed")), true);
  assert.equal(h.writes.find((m) => m.id === 100).error.code, -32602);
});

test("restart start failure ends once with the continuation error", async (t) => {
  const h = await launch(t);
  await h.steer.handler("restart", "now");
  h.complete(h.turn, "interrupted");
  await until(() => h.turnRequests().length === 2);
  h.send({ id: h.turnRequests()[1].id, error: { code: -32603, message: "restart failed" } });
  await h.run;
  assert.equal(h.events.filter((e) => e.kind === "result").length, 1);
  assert.equal(h.events.at(-1).ok, false);
  assert.equal(h.events.some((e) => e.kind === "error" && e.message.includes("restart failed")), true);
});

test("confirmations resolved after restart cannot approve or continue the previous turn", async (t) => {
  const h = await launch(t);
  const resolveConfirmations = [];
  h.confirm = () => new Promise((resolve) => resolveConfirmations.push(resolve));
  const requests = [
    ["item/commandExecution/requestApproval", { command: "old command" }],
    ["item/fileChange/requestApproval", { grantRoot: "/old" }],
    ["item/tool/requestUserInput", { questions: [{ id: "q1", question: "Old question" }, { id: "q2", question: "Must not open" }] }],
  ];
  requests.forEach(([method, params], i) => h.send({ id: 100 + i, method, params: { ...h.scope(), ...params } }));
  await until(() => resolveConfirmations.length === 3);
  await h.steer.handler("restart", "now");
  h.complete(h.turn, "interrupted");
  await until(() => h.turnRequests().length === 2);
  h.turn = "replacement-turn";
  h.acceptStart();
  await tick();
  resolveConfirmations.forEach((resolve) => resolve({ allow: true, answer: "stale answer" }));
  await tick();
  assert.equal(h.confirms.length, 3, "the second old question must not open");
  await until(() => h.writes.filter((m) => m.id >= 100 && !m.method).length >= 3);
  for (const id of [100, 101, 102]) {
    assert.equal(h.writes.find((m) => m.id === id).error?.code, -32602, "stale confirmation must be rejected");
  }
});

test("confirmation resolved after abort cannot approve the cancelled turn", async (t) => {
  const h = await launch(t);
  let resolveConfirmation;
  h.confirm = () => new Promise((resolve) => { resolveConfirmation = resolve; });
  h.send({ id: 100, method: "item/commandExecution/requestApproval", params: { ...h.scope(), command: "pending" } });
  await until(() => resolveConfirmation);
  h.abort.abort();
  resolveConfirmation({ allow: true });
  await until(() => h.writes.some((m) => m.id === 100 && !m.method));
  assert.equal(h.writes.find((m) => m.id === 100).error?.code, -32602);
  h.complete(h.turn, "interrupted");
  await h.run;
});

test("abort between confirmation continuation and JSON-RPC write rejects the approval", async (t) => {
  const h = await launch(t);
  let resolveConfirmation;
  const confirmation = new Promise((resolve) => { resolveConfirmation = resolve; });
  h.confirm = () => confirmation;
  h.send({ id: 100, method: "item/commandExecution/requestApproval", params: { ...h.scope(), command: "pending" } });
  await until(() => h.confirms.length === 1);
  // The backend's await resumes first; this reaction then aborts before the
  // outer handleServerRequest(...).then(write) continuation can send accept.
  confirmation.then(() => h.abort.abort());
  resolveConfirmation({ allow: true });
  await until(() => h.writes.some((m) => m.id === 100 && !m.method));
  assert.equal(h.writes.find((m) => m.id === 100).error?.code, -32602);
  h.complete(h.turn, "interrupted");
  await h.run;
});

const writerConflict = "thread-store conflict: writer already active";
const conflictReply = (h, request, message = writerConflict) => h.send({ id: request.id, error: { code: -32603, message } });

test("resume writer conflict forks stored history and starts the prompt once in the new session", async (t) => {
  const h = await launch(t, {
    resume: true,
    config: { model: "gpt-6-astra", effort: "high", sandbox: "read-only", contextWindow: 123 },
    attachments: [{ path: "/test/image.png", isImage: true }],
    onThread(request, h) {
      if (request.method === "thread/resume") conflictReply(h, request);
      if (request.method === "thread/fork") {
        h.thread = "forked-main";
        h.reply(request, { thread: { id: h.thread, forkedFromId: "resumed-main" }, model: "gpt-6-astra" });
      }
    },
  });
  assert.deepEqual(h.spawnArgs[1], ["app-server", "--listen", "stdio://"]);
  assert.equal(h.execCalls.length, 0);
  const forks = h.writes.filter((m) => m.method === "thread/fork");
  assert.equal(forks.length, 1);
  assert.deepEqual(forks[0].params, {
    threadId: "resumed-main", cwd: temp, model: "gpt-6-astra", sandbox: "read-only", approvalPolicy: "never", excludeTurns: true,
  });
  assert.deepEqual(h.events.filter((e) => e.kind === "session"), [{ kind: "session", sessionId: "forked-main" }]);
  const notice = h.events.findIndex((e) => e.kind === "notice" && /отдельн.*тред|отдельн.*ветк/iu.test(e.text));
  assert.ok(notice >= 0, "recovery must explain that continuation uses a separate thread");
  assert.match(h.events[notice].text, /истори/iu);
  assert.ok(notice < h.events.findIndex((e) => e.kind === "session"));
  assert.equal(h.turnRequests().length, 1);
  assert.deepEqual(h.turnRequests()[0].params, {
    threadId: "forked-main", effort: "high", input: [{ type: "text", text: "work" }, { type: "localImage", path: "/test/image.png" }],
  });
  const before = structuredClone(h.events);
  h.notify("item/agentMessage/delta", { threadId: "resumed-main", turnId: h.turn, itemId: "old", delta: "original text" });
  h.complete(h.turn, "completed", "resumed-main");
  await tick();
  assert.deepEqual(h.events, before);
  assert.equal(h.done, false);
  assert.equal(h.kills, 0);
  h.notify("item/completed", { ...h.scope(), item: { type: "agentMessage", id: "final", text: "Fork final" } });
  h.complete();
  await h.run;
  assert.equal(h.events.find((e) => e.kind === "assistantText").text, "Fork final");
  assert.equal(h.events.at(-1).ok, true);
});

for (const [label, forkResult] of [
  ["missing", {}], ["empty", { thread: { id: "" } }], ["whitespace", { thread: { id: "   " } }],
  ["same", { thread: { id: "resumed-main" } }], ["invalid", { thread: { id: 42 } }],
]) {
  test(`fork recovery rejects ${label} thread id without sending a task or exec fallback`, async (t) => {
    const h = await launch(t, {
      resume: true, start: false, waitFor: "thread",
      onThread(request, h) {
        if (request.method === "thread/resume") conflictReply(h, request);
        if (request.method === "thread/fork") h.reply(request, forkResult);
      },
    });
    await h.run;
    assert.equal(h.writes.filter((m) => m.method === "thread/fork").length, 1);
    assert.equal(h.turnRequests().length, 0);
    assert.equal(h.execCalls.length, 0);
    assert.equal(h.events.some((e) => e.kind === "session"), false);
    assert.equal(h.events.some((e) => e.kind === "error"), true);
    assert.equal(h.events.at(-1).ok, false);
  });
}

test("fork writer conflict fails clearly without recursion or another backend", async (t) => {
  const h = await launch(t, {
    resume: true, start: false, waitFor: "thread", onThread: (request, h) => conflictReply(h, request),
  });
  await h.run;
  assert.equal(h.writes.filter((m) => m.method === "thread/resume").length, 1);
  assert.equal(h.writes.filter((m) => m.method === "thread/fork").length, 1);
  assert.equal(h.turnRequests().length, 0);
  assert.equal(h.execCalls.length, 0);
  assert.match(h.events.find((e) => e.kind === "error").message, /не удалось.*(тред|ветк)/iu);
  assert.equal(h.events.at(-1).ok, false);
});

test("a non-conflict resume error retains the existing exec fallback", async (t) => {
  const h = await launch(t, {
    resume: true, start: false, waitFor: "thread", onThread: (request, h) => conflictReply(h, request, "unsupported thread/resume"),
  });
  await h.run;
  assert.equal(h.writes.some((m) => m.method === "thread/fork"), false);
  assert.deepEqual(h.execCalls, [{ prompt: "work", resumeSessionId: "resumed-main" }]);
  assert.equal(h.events.at(-1).ok, true);
});

for (const during of ["resume", "fork"]) {
  test(`abort during ${during} recovery never sends a new task`, async (t) => {
    const h = await launch(t, {
      resume: true, start: false, waitFor: "thread",
      onThread(request, h) {
        if (request.method === `thread/${during}`) h.abort.abort();
        if (request.method === "thread/resume") conflictReply(h, request);
        if (request.method === "thread/fork") h.reply(request, { thread: { id: "forked-main" } });
      },
    });
    await h.run;
    assert.equal(h.writes.filter((m) => m.method === "thread/fork").length, during === "fork" ? 1 : 0);
    assert.equal(h.turnRequests().length, 0);
    assert.equal(h.execCalls.length, 0);
    assert.equal(h.events.some((e) => e.kind === "session"), false);
  });
}

test("abort when the fork notice is shown prevents sending the new task", async (t) => {
  const h = await launch(t, {
    resume: true, start: false, waitFor: "thread",
    onThread(request, h) {
      if (request.method === "thread/resume") conflictReply(h, request);
      if (request.method === "thread/fork") h.reply(request, { thread: { id: "forked-main" } });
    },
    onEvent(event, h) { if (event.kind === "notice") h.abort.abort(); },
  });
  await h.run;
  assert.equal(h.writes.filter((m) => m.method === "thread/fork").length, 1);
  assert.equal(h.turnRequests().length, 0);
  assert.equal(h.execCalls.length, 0);
});

test("a writer conflict after turn/start never forks or replays the prompt", async (t) => {
  const h = await launch(t, { resume: true, start: false });
  conflictReply(h, h.turnRequests()[0]);
  await h.run;
  assert.equal(h.writes.some((m) => m.method === "thread/fork"), false);
  assert.equal(h.turnRequests().length, 1);
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.events.at(-1).ok, false);
});

test("backend completion waits for its child cleanup promise", async (t) => {
  const h = await launch(t);
  let stopRequested = false;
  h.stop = () => {
    stopRequested = true;
    return new Promise((resolve) => {
      h.releaseCleanup = () => {
        h.child.exitCode = 0;
        h.child.emit("exit", 0);
        resolve(true);
      };
    });
  };
  h.complete();
  await until(() => stopRequested);
  assert.equal(h.events.at(-1).kind, "result");
  assert.equal(h.done, false, "the generator must retain ownership until cleanup resolves");
  assert.equal(h.child.exitCode, null);
  h.releaseCleanup();
  await h.run;
  assert.equal(h.done, true);
});

test("failed cleanup of a previous owned process prevents spawning another child", async (t) => {
  const h = await launch(t, { resume: true, start: false, waitFor: "done", staleCleanup: false });
  assert.equal(h.spawnArgs, undefined);
  assert.equal(h.processTracking.length, 0);
  assert.equal(h.writes.length, 0);
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.events.some((e) => e.kind === "error"), true);
  assert.equal(h.events.at(-1).ok, false);
});

test("the owned app-server is tracked before its thread handshake completes", async (t) => {
  let threadRequest;
  const h = await launch(t, {
    resume: true, start: false, waitFor: "thread",
    onThread(request) { threadRequest = request; },
  });
  assert.deepEqual(h.processTracking, [{ child: h.child, writesAtTracking: 0 }]);
  assert.equal(h.turnRequests().length, 0);
  h.reply(threadRequest, { thread: { id: h.thread } });
  await until(() => h.turnRequests().length === 1);
  h.acceptStart();
  await until(() => h.steer.handler);
  h.complete();
  await h.run;
});
