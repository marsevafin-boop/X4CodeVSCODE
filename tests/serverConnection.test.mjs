import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-server-test-"));
const mockKey = Symbol.for("agent-hub.server-connection-tests");
let current;
globalThis[mockKey] = {
  spawn(command, args, options) {
    const child = new EventEmitter();
    const call = { command, args, options, child, stdin: "", kills: [] };
    current.calls.push(call);
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, encoding, callback) { call.stdin += chunk.toString(); callback(); },
      final(callback) { callback(); queueMicrotask(() => current.respond(call)); },
    });
    child.kill = (signal) => { call.kills.push(signal); return true; };
    return child;
  },
};
after(async () => {
  delete globalThis[mockKey];
  await rm(temp, { recursive: true, force: true });
});
const outfile = join(temp, "server.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/serverConnection.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "mock-process", setup(b) {
    b.onResolve({ filter: /^node:child_process$/ }, ({ path }) => ({ path, namespace: "mock" }));
    b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
      contents: 'export const spawn = (...args) => globalThis[Symbol.for("agent-hub.server-connection-tests")].spawn(...args);',
    }));
  } }],
});
const { testServerConnection, buildServerEnvironment, buildSshCommand, formatSshCommand } = await import(pathToFileURL(outfile).href);
const base = { host: "server.example", user: "deploy" };
const fakePassword = "fixture-only-P@ss'\"\\word";
function fixture(respond = (call) => finish(call, 0, "AGENT_HUB_OK\r\n")) {
  current = { calls: [], respond };
  return current;
}
function finish(call, code, out = "", err = "") {
  call.child.stdout.write(out);
  call.child.stderr.write(err);
  call.child.emit("close", code);
}

test("the shared builder exactly supplies SSH and SFTP probe arguments", async () => {
  for (const protocol of ["ssh", "sftp"]) {
    for (const port of [undefined, 2222]) {
      for (const authentication of ["password", "key"]) {
        const connection = { ...base, protocol, port };
        const h = fixture();
        const built = buildSshCommand(connection, authentication, protocol === "ssh" ? "echo AGENT_HUB_OK" : undefined);
        await testServerConnection(connection, authentication === "password" ? fakePassword : undefined);
        assert.equal(h.calls[0].command, built.command);
        assert.deepEqual(h.calls[0].args, built.args);
        assert.equal(Object.values(built).includes(fakePassword), false);
      }
    }
  }
});

test("the formatter shell quotes Windows users and does not overwrite an SSH alias port", () => {
  const command = formatSshCommand({ host: "my_ssh-alias", user: "DOMAIN\\service$" }, "password", "<команда>");
  assert.ok(command.includes("'DOMAIN\\service$@my_ssh-alias'"));
  assert.ok(command.endsWith("'<команда>'"));
  assert.equal(command.includes("-p "), false);
  assert.equal(command.includes("SSHPASS="), false);
});

test("the command builder rejects invalid connection data before formatting", () => {
  for (const connection of [{ host: "-oProxyCommand=bad" }, { ...base, user: "bad user" }, { ...base, port: 0 }, { ...base, protocol: "ftp" }]) {
    assert.throws(() => buildSshCommand(connection, "password"));
    assert.throws(() => formatSshCommand(connection, "password"));
  }
});

test("saved SSH password is checked directly through env, without key-first success", async () => {
  const h = fixture();
  const result = await testServerConnection({ ...base, port: 2222 }, fakePassword);
  assert.equal(result.ok, true);
  assert.match(result.message, /парол/iu);
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.command, "sshpass");
  assert.deepEqual(call.args.slice(0, 2), ["-e", "ssh"]);
  assert.equal(call.options.env.SSHPASS, fakePassword);
  assert.equal(call.args.some((arg) => arg.includes(fakePassword)), false);
  for (const option of ["BatchMode=no", "PreferredAuthentications=password,keyboard-interactive", "PubkeyAuthentication=no", "PasswordAuthentication=yes", "KbdInteractiveAuthentication=yes", "ControlMaster=no", "ControlPath=none"]) {
    assert.ok(call.args.includes(option), option);
  }
  assert.ok(call.args.includes("2222"));
  assert.deepEqual(call.args.slice(-2), ["deploy@server.example", "echo AGENT_HUB_OK"]);
  assert.equal(call.stdin, "");
});

for (const password of [undefined, ""]) {
  test(`SSH ${password === undefined ? "absent" : "empty"} password checks keys without ambient password aliases`, async (t) => {
    const aliases = ["SSHPASS", "AGENT_HUB_SERVER_PASSWORD", "LFTP_PASSWORD"];
    const original = aliases.map((key) => [key, process.env[key]]);
    for (const key of aliases) process.env[key] = "fixture-other-project";
    t.after(() => { for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    const h = fixture();
    assert.equal((await testServerConnection(base, password)).ok, true);
    assert.equal(h.calls[0].command, "ssh");
    assert.ok(h.calls[0].args.includes("BatchMode=yes"));
    assert.ok(h.calls[0].args.includes("PreferredAuthentications=publickey"));
    for (const key of aliases) assert.equal(h.calls[0].options.env[key], "");
  });
}

for (const [code, out] of [[255, "AGENT_HUB_OK\n"], [0, "banner AGENT_HUB_OK banner\n"], [0, ""]]) {
  test(`SSH requires both zero exit and an exact success marker (${code}, ${JSON.stringify(out)})`, async () => {
    fixture((call) => finish(call, code, out));
    assert.equal((await testServerConnection(base, fakePassword)).ok, false);
  });
}

test("password rejection does not fall back to keys or expose diagnostic secrets", async () => {
  const h = fixture((call) => finish(call, 5, "", `Permission denied ${fakePassword} ${encodeURIComponent(fakePassword)}`));
  const result = await testServerConnection(base, fakePassword);
  assert.equal(result.ok, false);
  assert.equal(h.calls.length, 1);
  assert.equal(result.message.includes(fakePassword), false);
  assert.equal(result.message.includes(encodeURIComponent(fakePassword)), false);
});

for (const [diagnostic, expected] of [
  ["Connection timed out", /таймаут/iu],
  ["Operation timed out", /таймаут/iu],
  ["Connection refused", /хост не найден|соединение.*(отклонено|недоступно)/iu],
  ["No route to host", /хост не найден|соединение.*(отклонено|недоступно)/iu],
  ["Network is unreachable", /хост не найден|соединение.*(отклонено|недоступно)/iu],
  ["Could not resolve hostname server.example", /хост не найден|соединение.*(отклонено|недоступно)/iu],
  ["Name or service not known", /хост не найден|соединение.*(отклонено|недоступно)/iu],
  ["Host key verification failed", /ключ.*сервер|host key/iu],
  ["WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", /ключ.*сервер|host key/iu],
]) {
  test(`SSH code 255 is safely classified: ${diagnostic}`, async () => {
    const h = fixture((call) => finish(call, 255, "", `${diagnostic}\n${fakePassword}`));
    const result = await testServerConnection(base, fakePassword);
    assert.equal(result.ok, false);
    assert.match(result.message, expected);
    assert.equal(result.message.includes(fakePassword), false);
    assert.equal(h.calls.length, 1);
    assert.ok(h.calls[0].args.includes("StrictHostKeyChecking=accept-new"));
    assert.equal(h.calls[0].args.includes("StrictHostKeyChecking=no"), false);
  });
}

test("SFTP code 255 uses the same safe connection diagnostics", async () => {
  const h = fixture((call) => finish(call, 255, "", `Operation timed out\n${fakePassword}`));
  const result = await testServerConnection({ ...base, protocol: "sftp" }, fakePassword);
  assert.equal(result.ok, false);
  assert.match(result.message, /таймаут/iu);
  assert.equal(result.message.includes(fakePassword), false);
  assert.equal(h.calls.length, 1);
});

test("missing sshpass gives an actionable error without leaking its exception", async () => {
  fixture((call) => call.child.emit("error", Object.assign(new Error(`spawn failed ${fakePassword}`), { code: "ENOENT" })));
  const result = await testServerConnection(base, fakePassword);
  assert.equal(result.ok, false);
  assert.match(result.message, /sshpass/u);
  assert.equal(result.message.includes(fakePassword), false);
});

test("password SFTP uses sshpass and an explicit noninteractive exit command", async () => {
  const h = fixture((call) => finish(call, 0));
  const result = await testServerConnection({ ...base, protocol: "sftp", port: 2222 }, fakePassword);
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls[0].args.slice(0, 2), ["-e", "sftp"]);
  assert.ok(h.calls[0].args.includes("PubkeyAuthentication=no"));
  assert.ok(h.calls[0].args.includes("-P"));
  assert.equal(h.calls[0].stdin, "bye\n");
  assert.equal(h.calls[0].options.env.SSHPASS, fakePassword);
});

test("key SFTP remains a batch probe", async () => {
  const h = fixture((call) => finish(call, 0));
  assert.equal((await testServerConnection({ ...base, protocol: "sftp" }, undefined)).ok, true);
  assert.equal(h.calls[0].command, "sftp");
  assert.ok(h.calls[0].args.includes("BatchMode=yes"));
});

test("FTP keeps credentials in escaped curl config on stdin only", async () => {
  const password = `${fakePassword}\n\r\t`;
  const h = fixture((call) => finish(call, 0, "one\ntwo\n"));
  const result = await testServerConnection({ ...base, protocol: "ftp", port: 2121 }, password);
  assert.equal(result.ok, true);
  assert.match(result.message, /2/u);
  const call = h.calls[0];
  assert.equal(call.command, "curl");
  assert.ok(call.args.includes("-K"));
  assert.ok(call.args.includes("-"));
  assert.equal(call.args.some((arg) => arg.includes(fakePassword)), false);
  assert.equal(Object.values(call.options.env).includes(password), false);
  assert.match(call.stdin, /ftp:\/\/server\.example:2121\//u);
  assert.match(call.stdin, /\\n\\r\\t/u);
  assert.equal(call.stdin.split("\n").filter((line) => line.startsWith("user = ")).length, 1);
});

for (const connection of [
  { host: "-oProxyCommand=evil" }, { host: "server\ncommand" }, { host: "server/path" }, { host: "x@host" }, { host: "" },
  { ...base, user: "-oProxyCommand=evil" }, { ...base, user: "user\ncommand" },
  { ...base, port: 0 }, { ...base, port: 65536 }, { ...base, port: 1.2 }, { ...base, port: "22" },
  { ...base, protocol: "shell" },
]) {
  test(`invalid connection is rejected before spawn: ${JSON.stringify(connection)}`, async () => {
    const h = fixture();
    assert.equal((await testServerConnection(connection, fakePassword)).ok, false);
    assert.equal(h.calls.length, 0);
  });
}

test("IPv6 addresses and SSH config aliases remain supported", async () => {
  for (const host of ["2001:db8::1", "[2001:db8::1]", "my_ssh-alias"]) {
    fixture();
    assert.equal((await testServerConnection({ host }, undefined)).ok, true);
  }
});

test("a hung probe is killed and resolves with timeout even without a close event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = fixture(() => {});
  const run = testServerConnection(base, fakePassword);
  await Promise.resolve();
  t.mock.timers.tick(15000);
  const result = await run;
  assert.equal(result.ok, false);
  assert.match(result.message, /таймаут/iu);
  assert.deepEqual(h.calls[0].kills, ["SIGKILL"]);
});

test("a timeout remains a safe result if signalling the child throws", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = fixture(() => {});
  const run = testServerConnection(base, fakePassword);
  h.calls[0].child.kill = () => { throw new Error(`fixture kill failure ${fakePassword}`); };
  assert.doesNotThrow(() => t.mock.timers.tick(15000));
  const result = await run;
  assert.equal(result.ok, false);
  assert.equal(result.message.includes(fakePassword), false);
});

test("saved password takes priority and all canonical aliases agree", () => {
  const input = { KEEP: "value", AGENT_HUB_SERVER_PASSWORD: "fixture-one", SSHPASS: "fixture-two", LFTP_PASSWORD: "fixture-three" };
  const output = buildServerEnvironment(input, fakePassword);
  assert.deepEqual(output, { KEEP: "value", AGENT_HUB_SERVER_PASSWORD: fakePassword, SSHPASS: fakePassword, LFTP_PASSWORD: fakePassword });
  assert.equal(input.SSHPASS, "fixture-two");
});

test("project-only aliases use a deterministic priority without ambient fallback", () => {
  for (const [input, password] of [
    [{ AGENT_HUB_SERVER_PASSWORD: "fixture-one", SSHPASS: "fixture-two" }, "fixture-one"],
    [{ SSHPASS: "fixture-two", LFTP_PASSWORD: "fixture-three" }, "fixture-two"],
    [{ LFTP_PASSWORD: "fixture-three" }, "fixture-three"],
    [{ AGENT_HUB_SERVER_PASSWORD: "", SSHPASS: "fixture-two" }, ""],
    [{ KEEP: "value" }, ""],
  ]) {
    const output = buildServerEnvironment(input);
    assert.equal(output.AGENT_HUB_SERVER_PASSWORD, password);
    assert.equal(output.SSHPASS, password);
    assert.equal(output.LFTP_PASSWORD, password);
  }
});

test("explicit empty saved password clears every alias without secretEnv fallback", () => {
  const output = buildServerEnvironment({ SSHPASS: "fixture-other-project", KEEP: "value" }, "");
  assert.deepEqual(output, { KEEP: "value", SSHPASS: "", AGENT_HUB_SERVER_PASSWORD: "", LFTP_PASSWORD: "" });
});
