import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const temp = await mkdtemp(join(tmpdir(), "agent-hub-server-state-test-"));
after(() => rm(temp, { recursive: true, force: true }));
const outfile = join(temp, "server-test-state.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../webview/serverTestState.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm",
});
const { idleServerTest, beginServerTest, reconcileServerTest, finishServerTest } =
  await import(pathToFileURL(outfile).href);
const draft = {
  projectPath: "/project/a", host: "server-alias", user: "deploy", port: 2222,
  protocol: "ssh", password: undefined,
};
const result = (requestId = "request-1", projectPath = draft.projectPath, ok = true) =>
  ({ requestId, projectPath, ok, message: ok ? "Connected" : "Failed" });

test("matching result confirms the exact tested draft", () => {
  const pending = beginServerTest(draft, "request-1");
  assert.equal(pending.status, "pending");
  const done = finishServerTest(pending, result(), draft);
  assert.equal(done.status, "ok");
  assert.equal(done.message, "Connected");
});

for (const [field, value] of Object.entries({
  projectPath: "/project/b", host: "different", user: "other", port: 22,
  protocol: "sftp", password: "override",
})) {
  test(`changing ${field} clears a successful draft check and rejects its late response`, () => {
    const pending = beginServerTest(draft, "request-1");
    const done = finishServerTest(pending, result(), draft);
    const changed = { ...draft, [field]: value };
    assert.equal(reconcileServerTest(done, changed).status, "idle");
    assert.equal(finishServerTest(pending, result(), changed).status, "idle");
  });
}

test("saved password, explicit deletion, and a replacement are distinct drafts", () => {
  const pending = beginServerTest(draft, "request-1");
  assert.equal(reconcileServerTest(pending, { ...draft, password: "" }).status, "idle");
  assert.equal(reconcileServerTest(pending, { ...draft, password: "new" }).status, "idle");
  const deletion = beginServerTest({ ...draft, password: "" }, "delete");
  assert.equal(reconcileServerTest(deletion, draft).status, "idle");
});

test("closing settings invalidates pending requests, and reopening cannot restore their results", () => {
  const pending = beginServerTest(draft, "request-1");
  const closed = reconcileServerTest(pending, null);
  assert.deepEqual(closed, idleServerTest());
  assert.deepEqual(finishServerTest(closed, result(), draft), idleServerTest());
});

test("another request or project cannot finish the pending check", () => {
  const pending = beginServerTest(draft, "request-2");
  assert.deepEqual(finishServerTest(pending, result(), draft), pending);
  assert.deepEqual(finishServerTest(pending, result("request-2", "/project/b"), draft), pending);
  assert.equal(finishServerTest(pending, result("request-2"), draft).status, "ok");
});

test("failure belongs to its request and a duplicate result cannot overwrite it", () => {
  const pending = beginServerTest(draft, "request-1");
  const failed = finishServerTest(pending, result("request-1", draft.projectPath, false), draft);
  assert.equal(failed.status, "fail");
  assert.deepEqual(finishServerTest(failed, result(), draft), failed);
});

test("cleared checks stay idle even when the user reverts their draft", () => {
  const pending = beginServerTest(draft, "request-1");
  const cleared = reconcileServerTest(pending, { ...draft, host: "edited" });
  assert.deepEqual(finishServerTest(cleared, result(), draft), idleServerTest());
});
