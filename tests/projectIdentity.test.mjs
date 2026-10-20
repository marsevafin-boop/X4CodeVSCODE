import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "agent-hub-project-identity-"));
after(() => rm(dir, { recursive: true, force: true }));
const outfile = join(dir, "identity.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/shared/projectIdentity.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
const { projectKey, isProjectId } = await import(pathToFileURL(outfile));

test("profiles sharing a working folder have separate stable keys", () => {
  const a = { id: "project-one", path: "/shared/folder" };
  const b = { id: "project-two", path: "/shared/folder" };
  assert.equal(projectKey(a), a.id);
  assert.equal(projectKey(b), b.id);
  assert.notEqual(projectKey(a), projectKey(b));
});
test("legacy keys keep the existing history and secret namespace unchanged", () => {
  assert.equal(projectKey({ path: "/legacy/folder" }), "/legacy/folder");
  assert.equal(projectKey({ path: "/legacy/folder/" }), "/legacy/folder/");
});
test("profile identity does not change when its working folder changes", () => {
  assert.equal(projectKey({ id: "project-one", path: "/new/folder" }), "project-one");
});
test("unsafe or unrecognized ids cannot become object store keys", () => {
  for (const id of ["", "__proto__", "constructor", "prototype", "/another/folder", "project-", "project-" + "a".repeat(121), null, 123]) {
    assert.equal(isProjectId(id), false);
    assert.equal(projectKey({ id, path: "/legacy/folder" }), "/legacy/folder");
  }
  assert.equal(isProjectId("project-a"), true);
  assert.equal(isProjectId("project-12345678-abcd-1234-abcd-123456789abc"), true);
});
