import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-bash-approval-"));
const stubKey = Symbol.for("agent-hub-bash-approval-tests");
let current;
globalThis[stubKey] = { get current() { return current; } };
after(async () => {
  delete globalThis[stubKey];
  await rm(temp, { recursive: true, force: true });
});

const providerFile = join(temp, "provider.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/ChatViewProvider.ts", import.meta.url))],
  outfile: providerFile,
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [{ name: "isolated-bash-approval", setup(b) {
    b.onResolve({ filter: /^(vscode|qrcode|node:child_process)$|^\.\/agents\/|^\.\/remoteServer$|^\.\/journal$/ }, ({ path }) => ({ path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const h = 'globalThis[Symbol.for("agent-hub-bash-approval-tests")].current';
      if (path === "vscode") return { contents: `export const workspace={getConfiguration:()=>({get:(key,fallback)=>Object.hasOwn(${h}.settings,key)?${h}.settings[key]:fallback})};export const Uri={},window={},commands={},ViewColumn={},ConfigurationTarget={},ProgressLocation={},env={};export class ThemeIcon{};` };
      if (path === "node:child_process") return { contents: 'export const spawn=()=>{throw new Error("unexpected external process in approval test")};' };
      if (path === "./journal") return { contents: 'export const readJournalContext=async()=>"";export const buildFinishPrompt=()=>"";' };
      if (path === "./remoteServer") return { contents: 'export class RemoteServer{};export const enableTailscaleFunnel=()=>{};export const generateToken=()=>"";export const lanAddresses=()=>[];export const tailscaleInfo=()=>{};' };
      if (path === "qrcode") return { contents: 'export const toString=()=>"";export default {};' };
      return { contents: 'export class ClaudeBackend{};export class CodexBackend{};export class CodexAppServerBackend{};export class CodexWriterRecoveryBackend{};export const codexDefaultModel=()=>"test";export const killAllCodex=()=>{};' };
    });
  } }],
});
const { ChatViewProvider } = await import(pathToFileURL(providerFile).href);
const policyFile = join(temp, "bashApproval.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/bashApproval.ts", import.meta.url))],
  outfile: policyFile, bundle: true, platform: "node", format: "esm",
});
const { isBashAutoAllowed } = await import(pathToFileURL(policyFile).href);
const defaultRules = ["git status", "git diff", "git log", "ls"];

function setup(settings = {}) {
  const h = { settings: { autoAllowTools: [], autoAllowBash: defaultRules, ...settings }, messages: [] };
  current = h;
  const p = Object.create(ChatViewProvider.prototype);
  p.pendingPermissions = new Map();
  p.postScoped = (_path, message) => h.messages.push(message);
  p.revealUi = () => {};
  p.notifyBackgroundPermission = () => {};
  return { ...h, p };
}

test("host: a compound Bash command requires approval even after an allowed prefix", () => {
  const { p } = setup();
  assert.equal(p.isAutoAllowed("Bash", { command: "git status && printf blocked" }), false);
});

test("host: adding Bash to the tool allowlist cannot bypass its command policy", () => {
  const { p } = setup({ autoAllowTools: ["Bash"] });
  assert.equal(p.isAutoAllowed("Bash", { command: "printf blocked" }), false);
});

test("host: a blocked Bash command remains pending until the user answers its card", async () => {
  const { p, messages } = setup();
  const response = p.confirmTool("Bash", { command: "git status && printf blocked" }, temp, "chat-one", "record-one");
  assert.equal(p.pendingPermissions.size, 1);
  const [requestId, pending] = [...p.pendingPermissions][0];
  assert.ok(messages.some(message => message.type === "permissionRequest" && message.requestId === requestId && message.kind === "tool"));
  assert.equal(pending.chatId, "chat-one");
  pending.resolve({ allow: false });
  p.pendingPermissions.delete(requestId);
  assert.deepEqual(await response, { allow: false });
});

test("host: ordinary allowed Bash commands and non-Bash tool permissions remain available", async () => {
  const { p } = setup({ autoAllowTools: ["Read"] });
  assert.deepEqual(await p.confirmTool("Bash", { command: "git status -s" }, temp), { allow: true });
  assert.equal(p.pendingPermissions.size, 0);
  assert.equal(p.isAutoAllowed("Read", { path: "file.txt" }), true);
  assert.equal(p.isAutoAllowed("Write", { path: "file.txt" }), false);
});

test("policy: default commands retain ordinary read-only options and literal operands", () => {
  const allowed = [
    "git status", "git status -s", "git status -sb", "git status --short --branch",
    "git status --porcelain", "git status --porcelain=v2", "git status -uno",
    "git status --untracked-files=all", "git status --ignored=matching",
    "git status --ignore-submodules=dirty", "git status -- src/file.ts",
    "git diff", "git diff --stat", "git diff --name-only", "git diff --name-status",
    "git diff --cached --stat", "git diff --no-ext-diff --no-textconv HEAD -- src/file.ts",
    "git diff -U3", "git diff -U 0", "git diff --unified=5", "git diff --unified 5",
    "git diff --color=never", "git diff --diff-filter=AM", "git diff --ignore-all-space",
    "git log", "git log --oneline -5", "git log --graph --decorate=short --all -n 5",
    "git log --max-count=0", "git log --max-count 10", "git log -n10",
    "git log --no-merges --first-parent main -- src/file.ts",
    "ls", "ls -la", "ls -lah src", "ls --all --human-readable .",
    "ls --color=auto", "ls --sort=time", "ls -- src -literal-file ./README.md ../docs /tmp",
    "  git\tstatus\t-s  ", "ls docs/a-b_c.ts ./1+2 @literal 100% comma,name",
  ];
  for (const command of allowed) assert.equal(isBashAutoAllowed(command, defaultRules), true, command);
});

test("policy: shell composition, expansion, quoting, and escaping always ask", () => {
  const blocked = [
    "git status && printf blocked", "git status||printf blocked", "git status ; printf blocked",
    "git status & printf blocked", "git diff | cat", "git log > output.txt", "ls >> output.txt",
    "ls < input.txt", "ls 2> error.txt", "ls &> output.txt", "ls <<< value", "ls << EOF",
    "git status\nprintf blocked", "git status\rprintf blocked", "git status\r\nprintf blocked",
    "ls\n", "git status\n", "ls -la\n", "git diff --stat\n", "ls -- file\n",
    "ls $(printf blocked)", "ls `printf blocked`", "ls ${HOME}", "ls $HOME", "ls $((1+1))",
    "ls <(printf blocked)", "ls >(cat)", "(ls)", "ls (file)", "{ ls; }", "ls {one,two}",
    "ls 'file'", "ls \"file\"", "ls file\\ name", "ls \\$(printf blocked)",
    "ls *", "ls file?", "ls [ab]", "ls ~", "ls !value", "ls #comment",
    "ls file\u0000name", "ls file\u001bname", "ls file\u007fname", "ls\vfile", "ls\ffile",
    "ls\u00a0file", "ls\u2028file", "ls zero\u200bwidth", "ls café", "ls 📁", "ls file;DROP",
    "PATH=/tmp ls", "A=1 git status", "ls file\\\nname",
  ];
  for (const command of blocked) assert.equal(isBashAutoAllowed(command, defaultRules), false, command);
});

test("policy: write, external-command, and unknown options require approval", () => {
  const blocked = [
    "git diff --output=report.txt", "git diff --output report.txt", "git diff -o report.txt",
    "git diff --ext-diff", "git diff --textconv", "git log --ext-diff", "git log --textconv",
    "git diff --no-index src/file.ts other.ts", "git log --show-signature", "git log --format=%GQ",
    "git status --exec=printf", "git log --exec printf", "git diff --unknown",
    "git diff --output-indicator-new=x", "git log --open-files-in-pager", "git status -v",
    "ls -o report.txt", "ls --ignore=src", "ls --help", "ls --unknown=value",
    "git -c core.pager=cat log", "git --no-pager log", "git --exec-path=/tmp status",
  ];
  for (const command of blocked) assert.equal(isBashAutoAllowed(command, defaultRules), false, command);
});

test("policy: option values must match the known finite or numeric forms", () => {
  const blocked = [
    "git status --porcelain=v3", "git status --untracked-files=unexpected", "git status -umaybe",
    "git status --ignored=yes", "git status --ignore-submodules=unexpected",
    "git diff --unified", "git diff -U", "git diff -U -1", "git diff --unified=abc",
    "git diff --unified=-1", "git diff --unified=", "git diff --color=unexpected",
    "git diff --diff-filter=Z", "git log --max-count", "git log --max-count=-1",
    "git log -n", "git log -n -5", "git log -nabc", "git log --decorate=unexpected",
    "ls --color=unexpected", "ls --sort=unexpected", "ls --sort time",
  ];
  for (const command of blocked) assert.equal(isBashAutoAllowed(command, defaultRules), false, command);
});

test("policy: double dash treats subsequent literal values as operands", () => {
  for (const command of ["git status -- --output", "git diff -- --ext-diff", "git log -- --textconv", "ls -- -o"]) {
    assert.equal(isBashAutoAllowed(command, defaultRules), true, command);
  }
  assert.equal(isBashAutoAllowed("git diff -- $(printf blocked)", defaultRules), false);
});

test("policy: command names match complete tokens rather than string prefixes", () => {
  for (const command of ["git statusx", "git status--short", "git diffx --stat", "git logger", "lsblk", "lsof", "./ls", "/bin/ls"]) {
    assert.equal(isBashAutoAllowed(command, defaultRules), false, command);
  }
  assert.equal(isBashAutoAllowed("git status", ["git"]), false);
  assert.equal(isBashAutoAllowed("ls", []), false);
});

test("policy: custom literal rules allow only their complete token sequence", () => {
  const rules = ["npm test", "echo approved", "git rev-parse HEAD", "git status -s", "ls -l"];
  for (const command of ["npm test", "  npm\ttest ", "echo approved", "git rev-parse HEAD", "git status -s", "ls -l"]) {
    assert.equal(isBashAutoAllowed(command, rules), true, command);
  }
  for (const command of ["npm test --watch", "npm tests", "echo approved extra", "git rev-parse HEAD main", "git status -s --branch", "ls -l src"]) {
    assert.equal(isBashAutoAllowed(command, rules), false, command);
  }
});

test("policy: configured dangerous or malformed commands cannot make themselves valid", () => {
  for (const rule of ["git diff --output=report.txt", "git diff --ext-diff", "git log --textconv", "ls -o report.txt", "ls;printf blocked", "echo $(printf blocked)", "A=1 ls", "ls\n"]) {
    assert.equal(isBashAutoAllowed(rule, [rule]), false, rule);
  }
});

test("policy: malformed commands and rule settings fail closed without throwing", () => {
  for (const command of [undefined, null, false, 1, {}, [], new String("ls"), "", " \t "]) {
    assert.equal(isBashAutoAllowed(command, defaultRules), false);
  }
  for (const rules of [undefined, null, false, 1, {}, "ls", [null], [1], [[]], [""], [" \t "], ["ls\n"], ["ls", null], [null, "ls"], new Array(2)]) {
    assert.equal(isBashAutoAllowed("ls", rules), false);
  }
  assert.equal(isBashAutoAllowed("ls", [" ls \t"]), true);
});

test("policy: large literal operand lists and rule lists keep their meaning", () => {
  const paths = Array.from({ length: 10_000 }, (_, i) => `path-${i}`);
  assert.equal(isBashAutoAllowed(`ls -- ${paths.join(" ")}`, ["ls"]), true);
  const rules = paths.map(path => `echo ${path}`);
  rules.push("ls");
  assert.equal(isBashAutoAllowed("ls -la", rules), true);
  assert.equal(isBashAutoAllowed("echo path-9999 extra", rules), false);
});

test("policy: independent calls do not retain allowlist decisions", async () => {
  const results = await Promise.all([
    Promise.resolve().then(() => isBashAutoAllowed("ls", ["ls"])),
    Promise.resolve().then(() => isBashAutoAllowed("ls", [])),
    Promise.resolve().then(() => isBashAutoAllowed("ls && printf blocked", ["ls"])),
  ]);
  assert.deepEqual(results, [true, false, false]);
});
