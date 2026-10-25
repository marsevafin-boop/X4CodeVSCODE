import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "agent-hub-agent-defaults-"));
after(() => rm(dir, { recursive: true, force: true }));
const outfile = join(dir, "defaults.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/shared/agentDefaults.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
const { normalizeAgentDefaults, normalizeAgentChoice, resolveAgentChoice, agentEffortLevels } = await import(pathToFileURL(outfile));

const baseline = () => ({ provider: "lastUsed", startup: { mode: "preserve" }, newProject: { mode: "default" }, newChat: { mode: "default" } });
const choice = (agent, modelOverrides = {}, effortOverrides = {}) => ({ agent, modelOverrides, effortOverrides });
const defaults = (value = {}) => normalizeAgentDefaults({ ...baseline(), ...value });

test("missing, null, primitive and array settings use backward-compatible defaults", () => {
  for (const value of [undefined, null, false, true, 0, 1, "codex", [], ["claude"]]) assert.deepEqual(normalizeAgentDefaults(value), baseline());
});

test("normalization retains supported provider selections and strips unrelated settings", () => {
  for (const provider of ["lastUsed", "claude", "codex"]) {
    assert.deepEqual(normalizeAgentDefaults({ provider, unknown: "discard", newChat: { mode: "preserve", agent: "codex", model: "discard" } }), {
      ...baseline(), provider, newChat: { mode: "preserve" },
    });
  }
  for (const provider of ["", "CODEx", " codex ", {}, null, "__proto__"]) assert.equal(normalizeAgentDefaults({ provider }).provider, "lastUsed");
});

test("invalid rules and custom providers fall back independently for each event", () => {
  for (const bad of [null, false, "custom", [], {}, { mode: "unknown" }, { mode: "custom" }, { mode: "custom", agent: "openai" }]) {
    assert.deepEqual(normalizeAgentDefaults({ startup: bad, newProject: bad, newChat: bad }), baseline());
  }
});

test("custom profiles trim model and effort and only accept provider-supported effort", () => {
  const actual = normalizeAgentDefaults({
    startup: { mode: "custom", agent: "claude", model: "  自分のモデル 📁  ", effort: " max ", secret: "discard" },
    newProject: { mode: "custom", agent: "codex", model: " model/custom;literal ", effort: " ultra " },
    newChat: { mode: "custom", agent: "claude", model: 12, effort: "ultra" },
  });
  assert.deepEqual(actual.startup, { mode: "custom", agent: "claude", model: "自分のモデル 📁", effort: "max" });
  assert.deepEqual(actual.newProject, { mode: "custom", agent: "codex", model: "model/custom;literal", effort: "ultra" });
  assert.deepEqual(actual.newChat, { mode: "custom", agent: "claude", model: "", effort: "" });
  assert.deepEqual(defaults({ newChat: { mode: "custom", agent: "codex", effort: "max" } }).newChat, { mode: "custom", agent: "codex", model: "", effort: "max" });
});

test("effort choices are provider-specific, include inherit, and cannot be mutated", () => {
  assert.deepEqual(agentEffortLevels("claude"), ["", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(agentEffortLevels("codex"), ["", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.throws(() => agentEffortLevels("claude").push("ultra"), TypeError);
  assert.equal(agentEffortLevels("claude").includes("ultra"), false);
});

test("choice normalization rejects invalid agents instead of inventing one", () => {
  for (const value of [undefined, null, false, 0, [], "codex", {}, { agent: null }, { agent: "lastUsed" }, { agent: "__proto__" }]) assert.equal(normalizeAgentChoice(value), undefined);
});

test("choice normalization retains only explicit nonempty provider model and effort overrides", () => {
  assert.deepEqual(normalizeAgentChoice({
    agent: "codex", model: "effective-not-explicit", unknown: "discard",
    modelOverrides: { claude: " model-claude ", codex: " ", unknown: "discard" },
    effortOverrides: { claude: " max ", codex: " ultra ", unknown: "high" },
  }), choice("codex", { claude: "model-claude" }, { claude: "max", codex: "ultra" }));
  assert.deepEqual(normalizeAgentChoice({ agent: "claude", modelOverrides: { codex: 12 }, effortOverrides: { claude: "ultra", codex: "max" } }), choice("claude", {}, { codex: "max" }));
  for (const value of [null, [], "model", 12]) assert.deepEqual(normalizeAgentChoice({ agent: "claude", modelOverrides: value, effortOverrides: value }), choice("claude"));
});

test("default last-used profile prefers the initiating chat over another workspace choice", () => {
  const current = choice("codex", { codex: "current-model" }, { codex: "ultra" });
  const lastUsed = choice("claude", { claude: "last-model" }, { claude: "max" });
  assert.deepEqual(resolveAgentChoice("newChat", defaults(), { current, lastUsed, fallbackAgent: "claude" }), current);
});

test("last-used defaults fall back to saved choice and then legacy agent", () => {
  const lastUsed = choice("codex", { codex: "remembered" }, { codex: "high" });
  assert.deepEqual(resolveAgentChoice("newProject", defaults(), { lastUsed, fallbackAgent: "claude" }), lastUsed);
  assert.deepEqual(resolveAgentChoice("newChat", defaults(), { fallbackAgent: "codex" }), choice("codex"));
  assert.deepEqual(resolveAgentChoice("newChat", defaults(), {}), choice("claude"));
});

test("a fixed common provider affects new project and new chat without pinning base values", () => {
  const config = defaults({ provider: "codex" });
  const current = choice("claude", { claude: "current-explicit", codex: "old-codex" }, { claude: "max", codex: "ultra" });
  for (const event of ["newProject", "newChat"]) assert.deepEqual(resolveAgentChoice(event, config, { current, lastUsed: current }), choice("codex"));
  assert.deepEqual(resolveAgentChoice("startup", config, { current }), current, "startup preserve remains authoritative");
});

test("preserve ignores the fixed common provider while an existing choice is available", () => {
  const config = defaults({ provider: "claude", newChat: { mode: "preserve" } });
  const current = choice("codex", { codex: "thread-model" }, { codex: "ultra" });
  assert.deepEqual(resolveAgentChoice("newChat", config, { current }), current);
  assert.deepEqual(resolveAgentChoice("newChat", config, { lastUsed: current }), current);
  assert.deepEqual(resolveAgentChoice("newChat", config, {}), choice("claude"));
});

test("startup may explicitly seed a default provider for an unbound chat", () => {
  const config = defaults({ provider: "codex", startup: { mode: "default" } });
  assert.deepEqual(resolveAgentChoice("startup", config, { lastUsed: choice("claude") }), choice("codex"));
});

test("custom profiles apply only selected-provider overrides and never carry unrelated overrides", () => {
  const config = defaults({ newChat: { mode: "custom", agent: "claude", model: "custom-model", effort: "xhigh" } });
  assert.deepEqual(resolveAgentChoice("newChat", config, { current: choice("codex", { codex: "old" }, { codex: "ultra" }) }),
    choice("claude", { claude: "custom-model" }, { claude: "xhigh" }));
});

test("blank custom model or effort inherits that provider's common configuration", () => {
  for (const agent of ["claude", "codex"]) {
    const config = defaults({ newProject: { mode: "custom", agent, model: " ", effort: " " } });
    assert.deepEqual(resolveAgentChoice("newProject", config, { current: choice("codex", { codex: "old" }, { codex: "ultra" }) }), choice(agent));
  }
});

test("resolving one event does not apply another event's custom rule", () => {
  const config = defaults({ startup: { mode: "custom", agent: "claude", model: "startup", effort: "low" }, newProject: { mode: "custom", agent: "codex", model: "project", effort: "high" } });
  assert.deepEqual(resolveAgentChoice("startup", config, {}), choice("claude", { claude: "startup" }, { claude: "low" }));
  assert.deepEqual(resolveAgentChoice("newProject", config, {}), choice("codex", { codex: "project" }, { codex: "high" }));
  assert.deepEqual(resolveAgentChoice("newChat", config, {}), choice("claude"));
});

test("default-following choices never materialize effective model or effort fields", () => {
  const raw = { agent: "codex", model: "base-model", effort: "high", modelOverrides: {}, effortOverrides: {} };
  assert.deepEqual(resolveAgentChoice("newChat", defaults(), { current: raw }), choice("codex"));
});

test("normalization and resolution never mutate inputs and return independent override maps", () => {
  const current = Object.freeze({ agent: "codex", modelOverrides: Object.freeze({ codex: "explicit" }), effortOverrides: Object.freeze({ codex: "ultra" }) });
  const raw = Object.freeze({ provider: "codex", startup: Object.freeze({ mode: "preserve" }), newProject: Object.freeze({ mode: "default" }), newChat: Object.freeze({ mode: "preserve" }) });
  const config = normalizeAgentDefaults(raw);
  assert.notEqual(config.startup, raw.startup);
  const result = resolveAgentChoice("newChat", config, { current });
  assert.deepEqual(result, current);
  assert.notEqual(result, current);
  assert.notEqual(result.modelOverrides, current.modelOverrides);
  assert.notEqual(result.effortOverrides, current.effortOverrides);
  result.modelOverrides.codex = "changed"; result.effortOverrides.codex = "low";
  assert.equal(current.modelOverrides.codex, "explicit");
  assert.equal(current.effortOverrides.codex, "ultra");
});

test("large unknown input collections do not leak fields into normalized profiles", () => {
  const unknown = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`unknown-${i}`, { agent: "codex" }]));
  assert.deepEqual(normalizeAgentDefaults(unknown), baseline());
  assert.deepEqual(normalizeAgentChoice({ agent: "claude", modelOverrides: unknown, effortOverrides: unknown }), choice("claude"));
});
