import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

// Exercise the actual adapters at their CLI/SDK boundary with fake credentials.
// No CLI, model, server, Keychain, or host process is contacted by these tests.
const temp = await mkdtemp(join(tmpdir(), "agent-hub-backend-env-test-"));
const mockKey = Symbol.for("agent-hub.backend-server-environment-tests");
const mockAccess = 'globalThis[Symbol.for("agent-hub.backend-server-environment-tests")]';
globalThis[mockKey] = {};
after(async () => {
  delete globalThis[mockKey];
  await rm(temp, { recursive: true, force: true });
});

async function loadBackend(file) {
  const outfile = join(temp, `${file}.mjs`);
  await build({
    entryPoints: [fileURLToPath(new URL(`../src/agents/${file}.ts`, import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [{
      name: "mock-agent-boundaries",
      setup(b) {
        b.onResolve({ filter: /^node:child_process$|^@anthropic-ai\/claude-agent-sdk$/ },
          ({ path }) => ({ path, namespace: "agent-boundary" }));
        b.onLoad({ filter: /.*/, namespace: "agent-boundary" }, ({ path }) => ({
          contents: path === "node:child_process"
            ? `export const spawn = (...args) => ${mockAccess}.spawn(...args);`
            : `export const query = (...args) => ${mockAccess}.query(...args);`,
        }));
      },
    }],
  });
  return import(pathToFileURL(outfile).href);
}

const { CodexAppServerBackend } = await loadBackend("codexAppServerBackend");
const { CodexBackend } = await loadBackend("codexBackend");
const { ClaudeBackend } = await loadBackend("claudeBackend");
const serverEnv = {
  SSHPASS: "fake-project-password",
  AGENT_HUB_SERVER_PASSWORD: "fake-project-password",
  LFTP_PASSWORD: "fake-project-password",
  CUSTOM_TOKEN: "fake-project-token",
};

function inheritedEnvironment(t) {
  const names = [...Object.keys(serverEnv), "AGENT_HUB_ENV_TEST_INHERITED"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of Object.keys(serverEnv)) process.env[name] = "fake-stale-parent-value";
  process.env.AGENT_HUB_ENV_TEST_INHERITED = "fake-parent-setting";
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function assertEnvironment(env) {
  for (const [name, value] of Object.entries(serverEnv)) assert.equal(env[name], value, name);
  assert.equal(env.AGENT_HUB_ENV_TEST_INHERITED, "fake-parent-setting");
  assert.equal(process.env.SSHPASS, "fake-stale-parent-value", "adapter must not mutate parent env");
  assert.equal(process.env.CUSTOM_TOKEN, "fake-stale-parent-value");
}

function options() {
  return {
    cwd: temp,
    config: { model: "test-model", contextWindow: 0 },
    extraEnv: { ...serverEnv },
    signal: new AbortController().signal,
    confirmTool: async () => ({ allow: true }),
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => assert.fail("fixture must complete without sending signals");
  child.complete = () => {
    child.exitCode = 0;
    child.stdout.end();
    child.emit("exit", 0);
    child.emit("close", 0);
  };
  return child;
}

async function collect(backend, opts = options()) {
  const events = [];
  for await (const event of backend.start("environment test", opts)) events.push(event);
  assert.equal(events.some((event) => event.kind === "result" && event.ok), true);
  assert.deepEqual(events.filter((event) => event.kind === "error"), []);
}

test("Codex app-server passes fresh project credentials and custom env to spawn", { timeout: 5000 }, async (t) => {
  inheritedEnvironment(t);
  const child = fakeChild();
  const requests = [];
  const reply = (request, result) => child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString());
      requests.push(request);
      if (request.method === "initialize") reply(request, {});
      if (request.method === "thread/start") reply(request, { thread: { id: "env-test-main" }, model: "test-model" });
      if (request.method === "turn/start") {
        reply(request, { turn: { id: "env-test-turn", status: "inProgress" } });
        setImmediate(() => {
          child.stdout.write(JSON.stringify({ method: "turn/completed", params: {
            threadId: "env-test-main", turn: { id: "env-test-turn", status: "completed" },
          } }) + "\n");
          child.complete();
        });
      }
      callback();
    },
  });
  let spawnCount = 0;
  globalThis[mockKey].spawn = (command, args, opts) => {
    spawnCount++;
    assert.equal(command, "codex");
    assert.equal(args[0], "app-server");
    assertEnvironment(opts.env);
    assert.equal(args.some((arg) => Object.values(serverEnv).some((value) => arg.includes(value))), false);
    return child;
  };
  await collect(new CodexAppServerBackend());
  assert.equal(spawnCount, 1);
  assert.equal(requests.some((request) => request.method === "turn/start"), true);
  assert.equal(Object.values(serverEnv).some((value) => JSON.stringify(requests).includes(value)), false,
    "credentials must remain in process env, outside thread requests");
});

test("Codex exec passes fresh project credentials and custom env to spawn", { timeout: 5000 }, async (t) => {
  inheritedEnvironment(t);
  const child = fakeChild();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
    final(callback) {
      setImmediate(() => {
        child.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
        child.complete();
      });
      callback();
    },
  });
  let spawnCount = 0;
  globalThis[mockKey].spawn = (command, args, opts) => {
    spawnCount++;
    assert.equal(command, "codex");
    assert.equal(args[0], "exec");
    assertEnvironment(opts.env);
    assert.equal(args.some((arg) => Object.values(serverEnv).some((value) => arg.includes(value))), false);
    return child;
  };
  await collect(new CodexBackend());
  assert.equal(spawnCount, 1);
});

test("Claude SDK receives fresh project credentials and custom env in query options", { timeout: 5000 }, async (t) => {
  inheritedEnvironment(t);
  let queryCount = 0;
  globalThis[mockKey].query = ({ options: sdkOptions }) => {
    queryCount++;
    assertEnvironment(sdkOptions.env);
    return (async function* () {
      yield { type: "result", subtype: "success", total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    })();
  };
  await collect(new ClaudeBackend());
  assert.equal(queryCount, 1);
});
