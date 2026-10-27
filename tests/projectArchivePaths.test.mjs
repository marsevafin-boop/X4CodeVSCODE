import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rename, lstat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";
const temp = await mkdtemp(join(tmpdir(), "agent-hub-archive-paths-"));
const fsKey = Symbol.for("agent-hub-archive-paths-fs");
const filesystem = { lstat };
globalThis[fsKey] = filesystem;
after(async () => { delete globalThis[fsKey]; await rm(temp, { recursive: true, force: true }); });
const outfile = join(temp, "paths.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/projectArchive.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "archive-filesystem", setup(b) {
    b.onResolve({ filter: /^node:fs\/promises$/, namespace: "file" }, ({ path }) => ({ path, namespace: "archive-fs" }));
    b.onLoad({ filter: /.*/, namespace: "archive-fs" }, () => ({ contents: `
      export * from "node:fs/promises";
      export const lstat = (...args) => globalThis[Symbol.for("agent-hub-archive-paths-fs")].lstat(...args);
    ` }));
  } }],
});
const { normalizeProjectArchive, directoriesOverlap, pathEntryExists, planProjectMove, executeProjectMove } = await import(pathToFileURL(outfile).href);
async function fixture() { const parent = await mkdtemp(join(temp, "paths-")); const folder = join(parent, "project"); await mkdir(folder); return { parent, folder }; }

test("archive metadata accepts only direct children of the sibling Archive and finite dates", () => {
  const original = join(temp, "project"); const value = { path: join(temp, "Archive", "project"), archivedAt: 123 };
  assert.deepEqual(normalizeProjectArchive(original, value), value);
  for (const bad of [null, undefined, "text", {}, { path: value.path }, { path: value.path, archivedAt: Infinity }, { path: value.path, archivedAt: -1 }, { path: "relative", archivedAt: 1 }, { path: join(temp, "outside"), archivedAt: 1 }, { path: join(value.path, "nested"), archivedAt: 1 }]) assert.equal(normalizeProjectArchive(original, bad), undefined);
  assert.equal(normalizeProjectArchive("relative", value), undefined);
  assert.equal(normalizeProjectArchive("/", { path: "/Archive/project", archivedAt: 0 }), undefined);
  assert.equal(normalizeProjectArchive(join(temp, "Archive"), value), undefined);
});

test("overlap detects equal, parent, child and excludes similar siblings", () => {
  assert.equal(directoriesOverlap("/a/project", "/a/project"), true);
  assert.equal(directoriesOverlap("/a/project", "/a/project/child"), true);
  assert.equal(directoriesOverlap("/a/project/child", "/a/project"), true);
  assert.equal(directoriesOverlap("/a/project", "/a/project-other"), false);
  assert.equal(directoriesOverlap("/a/project", "/b/project"), false);
});

test("planning never creates Archive and refuses unsafe roots or non-directory sources", async () => {
  const { parent, folder } = await fixture();
  const plan = await planProjectMove(folder); assert.equal(plan.destination, join(parent, "Archive", "project"));
  assert.equal(await pathEntryExists(join(parent, "Archive")), false);
  await assert.rejects(planProjectMove("relative"), /абсолютный/);
  await assert.rejects(planProjectMove("/"), /корень/);
  await assert.rejects(planProjectMove(join(parent, "Archive")), /Archive/);
  await assert.rejects(planProjectMove(join(parent, "missing")), { code: "ENOENT" });
  const file = join(parent, "file"); await writeFile(file, "content"); await assert.rejects(planProjectMove(file), /не является папкой/);
});

test("planning validates Archive and original root symlinks, restore location and occupied target", async () => {
  const { parent, folder } = await fixture();
  const archive = join(parent, "Archive"); await symlink(folder, archive);
  await assert.rejects(planProjectMove(folder), /символическая/); await rm(archive);
  await writeFile(archive, "file"); await assert.rejects(planProjectMove(folder), /не является папкой/); await rm(archive);
  const alias = join(parent, "alias"); await symlink(folder, alias); await assert.rejects(planProjectMove(alias), /символическая/);
  await mkdir(archive); const moved = join(archive, "project"); await rename(folder, moved);
  await assert.rejects(planProjectMove(folder, { path: join(parent, "outside"), archivedAt: 1 }), /некорректен/);
  const restoring = await planProjectMove(folder, { path: moved, archivedAt: 1 }); assert.equal(restoring.destination, folder);
  await symlink(join(parent, "missing"), folder); assert.equal(await pathEntryExists(folder), true);
  await assert.rejects(planProjectMove(folder, { path: moved, archivedAt: 1 }), /занят/);
});

test("move renames all data with persist and revalidates collisions without copy fallback", async () => {
  const { parent, folder } = await fixture(); await writeFile(join(folder, "file"), "fixture");
  let persisted = 0; const plan = await planProjectMove(folder);
  await executeProjectMove(plan, { rename, persist: async () => { persisted++; } });
  assert.equal(persisted, 1); assert.equal(await readFile(join(plan.destination, "file"), "utf8"), "fixture");
  const restore = await planProjectMove(folder, { path: plan.archivePath, archivedAt: 1 });
  await executeProjectMove(restore, { rename, persist: async () => {} });
  const stale = await planProjectMove(folder); await mkdir(stale.destination);
  await assert.rejects(executeProjectMove(stale, { rename, persist: async () => {} }), /изменился/);
  assert.equal(await readFile(join(folder, "file"), "utf8"), "fixture");
});

test("move rolls back a failed persist and reports preserved paths when rollback cannot run", async () => {
  const { folder } = await fixture(); let calls = 0;
  const plan = await planProjectMove(folder);
  await assert.rejects(executeProjectMove(plan, { rename, persist: async () => { throw new Error("save failed"); } }), /save failed/);
  assert.equal(await pathEntryExists(folder), true);
  await assert.rejects(executeProjectMove(plan, { rename: async (src, dst) => { if (++calls === 2) throw new Error("rollback failed"); await rename(src, dst); }, persist: async () => { throw new Error("save failed"); } }), (error) => error.message.includes(plan.destination) && error.message.includes(plan.source));
  assert.equal((await lstat(plan.destination)).isDirectory(), true);
});

test("rollback never overwrites a newly occupied source and path lookup propagates filesystem errors", async (t) => {
  const { folder } = await fixture(); const plan = await planProjectMove(folder);
  await assert.rejects(executeProjectMove(plan, { rename, persist: async () => { await mkdir(folder); throw new Error("save failed"); } }), /Исходный путь уже занят/);
  assert.equal((await lstat(plan.destination)).isDirectory(), true);
  const notDirectory = join(folder, "file"); await writeFile(notDirectory, "file");
  const lookupPath = join(notDirectory, "nested");
  const lookupError = Object.assign(new Error("lstat failed"), { code: "ENOTDIR" });
  // A file ancestor yields ENOENT on Windows; inject ENOTDIR to test propagation on every OS.
  t.mock.method(filesystem, "lstat", async (value) => {
    if (value === lookupPath) throw lookupError;
    return lstat(value);
  });
  await assert.rejects(pathEntryExists(lookupPath), (error) => error === lookupError);
});
