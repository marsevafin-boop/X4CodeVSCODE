import type { AgentId } from "./protocol";

export type AgentDefaultEvent = "startup" | "newProject" | "newChat";

export type AgentDefaultRule =
  | { mode: "preserve" | "default" }
  | { mode: "custom"; agent: AgentId; model: string; effort: string };

export interface AgentDefaults {
  provider: AgentId | "lastUsed";
  startup: AgentDefaultRule;
  newProject: AgentDefaultRule;
  newChat: AgentDefaultRule;
}

/** Only explicit session overrides belong here; empty values follow common settings. */
export interface AgentChoice {
  agent: AgentId;
  modelOverrides?: Partial<Record<AgentId, string>>;
  effortOverrides?: Partial<Record<AgentId, string>>;
}

export interface AgentChoiceContext {
  current?: AgentChoice;
  lastUsed?: AgentChoice;
  fallbackAgent?: AgentId;
}

const CLAUDE_EFFORTS = Object.freeze(["", "low", "medium", "high", "xhigh", "max"]);
const CODEX_EFFORTS = Object.freeze(["", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const AGENTS: readonly AgentId[] = ["claude", "codex"];

export function agentEffortLevels(agent: AgentId): readonly string[] {
  return agent === "codex" ? CODEX_EFFORTS : CLAUDE_EFFORTS;
}

function isAgent(value: unknown): value is AgentId {
  return value === "claude" || value === "codex";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRule(value: unknown, event: AgentDefaultEvent): AgentDefaultRule {
  const rule = object(value);
  if (rule.mode === "preserve" || rule.mode === "default") return { mode: rule.mode };
  if (rule.mode === "custom" && isAgent(rule.agent)) {
    const effort = text(rule.effort);
    return { mode: "custom", agent: rule.agent, model: text(rule.model), effort: agentEffortLevels(rule.agent).includes(effort) ? effort : "" };
  }
  return { mode: event === "startup" ? "preserve" : "default" };
}

export function normalizeAgentDefaults(value: unknown): AgentDefaults {
  const settings = object(value);
  return {
    provider: isAgent(settings.provider) ? settings.provider : "lastUsed",
    startup: normalizeRule(settings.startup, "startup"),
    newProject: normalizeRule(settings.newProject, "newProject"),
    newChat: normalizeRule(settings.newChat, "newChat"),
  };
}

function normalizeOverrides(value: unknown, effort: boolean): Partial<Record<AgentId, string>> {
  const fields = object(value);
  const result: Partial<Record<AgentId, string>> = {};
  for (const agent of AGENTS) {
    const explicit = text(fields[agent]);
    if (explicit && (!effort || agentEffortLevels(agent).includes(explicit))) result[agent] = explicit;
  }
  return result;
}

export function normalizeAgentChoice(value: unknown): AgentChoice | undefined {
  const choice = object(value);
  if (!isAgent(choice.agent)) return undefined;
  return {
    agent: choice.agent,
    modelOverrides: normalizeOverrides(choice.modelOverrides, false),
    effortOverrides: normalizeOverrides(choice.effortOverrides, true),
  };
}

/** Resolve creation policy without copying computed global settings into a session. */
export function resolveAgentChoice(event: AgentDefaultEvent, defaults: AgentDefaults, context: AgentChoiceContext = {}): AgentChoice {
  const settings = normalizeAgentDefaults(defaults);
  const rule = settings[event];
  if (rule.mode === "custom") {
    return {
      agent: rule.agent,
      modelOverrides: rule.model ? { [rule.agent]: rule.model } : {},
      effortOverrides: rule.effort ? { [rule.agent]: rule.effort } : {},
    };
  }
  if (rule.mode === "preserve" || settings.provider === "lastUsed") {
    const retained = normalizeAgentChoice(context.current) ?? normalizeAgentChoice(context.lastUsed);
    if (retained) return retained;
  }
  const agent = isAgent(settings.provider) ? settings.provider : isAgent(context.fallbackAgent) ? context.fallbackAgent : "claude";
  return { agent, modelOverrides: {}, effortOverrides: {} };
}
