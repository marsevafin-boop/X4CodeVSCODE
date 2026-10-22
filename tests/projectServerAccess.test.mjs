import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-project-access-"));
const key = Symbol.for("agent-hub-project-access-tests");
const harness = { spawns: [] };
globalThis[key] = harness;
after(async () => { delete globalThis[key]; await rm(temp, { recursive: true, force: true }); });
harness.spawn = (command, args, options) => {
  harness.spawns.push({ command, args, options });
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => true;
  queueMicrotask(() => { child.stdout.end("AGENT_HUB_OK\n"); child.emit("close", 0); });
  return child;
};
const outfile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "isolated-extension-dependencies", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      if (path === "vscode") return { contents: "export const workspace={getConfiguration:()=>({get:(_key,fallback)=>fallback,update:async()=>{}})}; export const Uri={},window={},commands={},ViewColumn={},ConfigurationTarget={},ProgressLocation={},env={}; export class ThemeIcon{};" };
      if (path === "node:child_process") return { contents: 'export const spawn=(...args)=>globalThis[Symbol.for("agent-hub-project-access-tests")].spawn(...args);' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>""; export const buildFinishPrompt=()=>"";' };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{}; export const enableTailscaleFunnel=()=>{}; export const generateToken=()=>""; export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>""; export default {};' };
      return { contents: 'export class ClaudeBackend{}; export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{}; export const codexDefaultModel=()=>"test";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(outfile).href);
const a = { path: "/project-a", name: "A", serverHost: "a.example", serverUser: "alice" };
const b = { path: "/project-b", name: "B", serverHost: "b.example", serverUser: "bob", serverPort: 2222 };
function provider() {
  harness.spawns.length = 0;
  const p = Object.create(ChatViewProvider.prototype);
  const data = new Map();
  p.context = { globalState: {
    get: (name, fallback) => data.has(name) ? data.get(name) : fallback,
    update: async (name, value) => { data.set(name, value); },
  }, secrets: { get: async (name) => ({
    "agentHub.serverPassword:/project-a": "password-a",
    "agentHub.serverPassword:/project-b": "password-b",
  })[name] } };
  p.getProjects = () => [a, b];
  p.getActiveProject = () => a;
  p.getSecretEnv = async () => ({});
  p.messages = []; p.post = (m) => p.messages.push(m);
  return p;
}
const request = (extra = {}) => ({ type: "testServer", projectPath: b.path, requestId: "request-b", host: b.serverHost, user: b.serverUser, port: b.serverPort, ...extra });

test("connection test uses form project secret while another project is active", async () => {
  const p = provider();
  await p.testServer(request());
  const attempt = harness.spawns.find((s) => s.command === "sshpass");
  assert.ok(attempt, "saved password must be checked explicitly");
  assert.equal(attempt.options.env.SSHPASS, "password-b");
  assert.ok(attempt.args.includes("bob@b.example"));
  assert.deepEqual(p.messages.at(-1), { type: "serverTestResult", projectPath: b.path, requestId: "request-b", ok: true, message: p.messages.at(-1).message });
});

test("explicit password removal tests keys without falling back to saved or alias credentials", async () => {
  const p = provider(); p.getSecretEnv = async () => ({ SSHPASS: "old-alias" });
  await p.testServer(request({ password: "" }));
  assert.ok(harness.spawns.some((s) => s.command === "ssh"));
  assert.equal(harness.spawns.some((s) => s.command === "sshpass"), false);
});

test("draft override is exact and only the request's password reaches authentication", async () => {
  const p = provider();
  await p.testServer(request({ password: " draft $'password `value` " }));
  assert.equal(harness.spawns.find((s) => s.command === "sshpass").options.env.SSHPASS, " draft $'password `value` ");
});

test("unknown project cannot read a secret or launch a connection", async () => {
  const p = provider(); p.context.secrets.get = () => { throw new Error("secret read"); };
  await p.testServer(request({ projectPath: "/deleted" }));
  assert.equal(harness.spawns.length, 0);
  assert.equal(p.messages.at(-1).ok, false);
});

test("project card names SSHPASS and avoids implying a different env is read by plain -e", async () => {
  const p = provider(); const card = await p.buildProjectCard(b);
  assert.match(card, /SSHPASS/);
  assert.equal(card.includes("password-b"), false);
});

for (const protocol of ["ssh", "sftp"]) {
  for (const port of [undefined, 2222]) {
    for (const password of ["fixture-command-password", ""]) {
      test(`${protocol} card and built-in check share ${password ? "password" : "key"} options with ${port ?? "configured"} port`, async () => {
        const p = provider();
        const project = { ...b, serverProtocol: protocol, serverPort: port, serverUser: "DOMAIN\\service$" };
        p.getProjects = () => [project];
        const card = await p.buildProjectCard(project, { SSHPASS: password, AGENT_HUB_SERVER_PASSWORD: password, LFTP_PASSWORD: password });
        await p.testServer(request({ protocol, port, user: project.serverUser, password }));
        const attempt = harness.spawns[0];
        assert.ok(attempt);
        const command = card.split("\n").find((line) => line.startsWith("Подключение: "))?.slice("Подключение: ".length);
        assert.ok(command, "card must contain the shared command example");
        const actualOptions = [...command.matchAll(/-o (?:'([^']+)'|([^\s]+))/g)].map((m) => m[1] ?? m[2]);
        const expectedOptions = attempt.args.flatMap((arg, index) => arg === "-o" ? [attempt.args[index + 1]] : []);
        assert.deepEqual(actualOptions, expectedOptions);
        const portFlag = protocol === "ssh" ? "-p" : "-P";
        if (port !== undefined) {
          assert.ok(command.includes(`${portFlag} ${port}`));
          assert.equal(attempt.args[attempt.args.indexOf(portFlag) + 1], String(port));
        } else {
          assert.equal(command.includes(`${portFlag} `), false);
          assert.equal(attempt.args.includes(portFlag), false);
        }
        assert.ok(command.includes("'DOMAIN\\service$@b.example'"), "Windows user target must be shell quoted");
        assert.equal(card.includes("fixture-command-password"), false);
        if (password) {
          assert.ok(command.startsWith(`sshpass -e ${protocol} `));
          assert.match(card, /встроенн.*проверк/iu);
        } else {
          assert.ok(command.startsWith(`${protocol} `));
          assert.match(card, /пароль.*не задан/iu);
          assert.match(card, /друг.*проект/iu);
          assert.match(card, /SSHPASS.*пуст/iu);
        }
        if (protocol === "ssh") {
          assert.ok(command.endsWith("'<команда>'"));
          assert.equal(card.includes("AGENT_HUB_OK"), false);
        } else {
          assert.ok(command.includes("-b -"));
          assert.match(card, /stdin/iu);
        }
      });
    }
  }
}

test("invalid SSH connection data cannot become a command example in the project card", async () => {
  const p = provider();
  const card = await p.buildProjectCard({ ...b, serverHost: "-oProxyCommand=fixture" });
  assert.equal(card.includes("Подключение:"), false);
  assert.match(card, /некорректн.*настройк/iu);
  assert.equal(card.includes("ProxyCommand"), false);
});

test("FTP project instructions keep password out of command arguments", async () => {
  const p = provider(); const card = await p.buildProjectCard({ ...b, serverProtocol: "ftp" });
  assert.match(card, /lftp --env-password/);
  assert.equal(card.includes("--user"), false);
  assert.equal(card.includes("password-b"), false);
});

test("password deletion stays effective after saving even when secret env has an old alias", async () => {
  const p = provider(); const saved = new Map([["agentHub.serverPassword:/project-b", "old-password"]]);
  p.context.secrets = { get: async (name) => saved.get(name), store: async (name, value) => saved.set(name, value), delete: async (name) => saved.delete(name) };
  p.getSecretEnv = async () => ({ SSHPASS: "old-alias" });
  p.postFullState = () => {}; p.postSettings = async () => {};
  await p.applySettings({ project: b, newPassword: "", claude: {}, codex: {} });
  await p.testServer(request());
  assert.equal(harness.spawns.some((s) => s.command === "sshpass"), false);
  p.getActiveProject = () => b;
  assert.equal((await p.buildSettingsSnapshot()).projectHasPassword, false);
});

test("resumed turns refresh project context and pass canonical credentials to backend", async () => {
  const p = provider();
  const project = { ...b, path: temp };
  p.getProjects = () => [a, project];
  p.context.secrets.get = async () => "fresh-password";
  p.getSecretEnv = async () => ({ SSHPASS: "obsolete", CUSTOM_TOKEN: "project-token" });
  p.runs = new Map(); p.steers = new Map(); p.steerTexts = new Map(); p.deferred = new Map();
  p.directoryRuns = new Map(); p.sessionWriters = new Map(); p.pendingPermissions = new Map();
  p.relocateAttachments = async (_cwd, attachments) => attachments;
  p.autoPull = async () => {};
  const record = { id: "record", createdAt: 1, agentIds: { codex: "resumed", claude: null }, chatLog: [] };
  p.ensureActiveRecord = async () => record;
  p.mutateRecord = async (_cwd, _id, fn) => fn(record);
  p.buildAgentConfig = () => ({ contextWindow: 0 });
  let call;
  p.backends = { codex: { async *start(prompt, options) { call = { prompt, options }; yield { kind: "result", ok: false }; } } };
  await p.runTurn("check access", "codex", [], temp);
  assert.ok(call);
  assert.match(call.prompt, /bob@b\.example/);
  assert.match(call.prompt, /SSHPASS/);
  assert.equal(call.prompt.includes("fresh-password"), false);
  assert.equal(call.options.extraEnv.SSHPASS, "fresh-password");
  assert.equal(call.options.extraEnv.AGENT_HUB_SERVER_PASSWORD, "fresh-password");
  assert.equal(call.options.extraEnv.LFTP_PASSWORD, "fresh-password");
  assert.equal(call.options.extraEnv.CUSTOM_TOKEN, "project-token");
  assert.equal(call.options.resumeSessionId, "resumed");
});
