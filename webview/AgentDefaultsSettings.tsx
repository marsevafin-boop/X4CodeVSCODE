import { useId } from "react";
import type { AgentId, AgentModelCatalog } from "../src/shared/protocol";
import {
  agentEffortLevels,
  normalizeAgentDefaults,
  type AgentDefaultEvent,
  type AgentDefaultRule,
  type AgentDefaults,
} from "../src/shared/agentDefaults";

type Profile = { model: string; effort: string };
const agentNames: Record<AgentId, string> = { claude: "Claude", codex: "GPT (Codex)" };

function ProfileFields({ agent, profile, catalog, context, inherit, inheritedModel, onChange }: {
  agent: AgentId;
  profile: Profile;
  catalog?: AgentModelCatalog;
  context: string;
  inherit: boolean;
  inheritedModel?: string;
  onChange: (profile: Profile) => void;
}) {
  const listId = useId();
  const models = catalog?.[agent] ?? [];
  const levelsFor = (model: string) => {
    const effectiveModel = model.trim() || inheritedModel?.trim();
    const supplied = models.find((option) => option.value === effectiveModel)?.efforts;
    return supplied
      ? [...new Set(["", ...supplied.filter((effort) => agentEffortLevels(agent).includes(effort))])]
      : agentEffortLevels(agent);
  };
  const levels = levelsFor(profile.model);
  return (
    <>
      <label className="set-row">
        <span>Модель</span>
        <input
          aria-label={`${context}: модель ${agentNames[agent]}`}
          value={profile.model}
          list={listId}
          placeholder={inherit ? "пусто — общая модель провайдера" : "пусто — модель из CLI"}
          onChange={(event) => {
            const model = event.target.value;
            onChange({ model, effort: levelsFor(model).includes(profile.effort) ? profile.effort : "" });
          }}
        />
        <datalist id={listId}>
          {models.map((model) => <option key={model.value} value={model.value}>{model.label ?? model.value}</option>)}
        </datalist>
      </label>
      <label className="set-row">
        <span>Effort</span>
        <select
          aria-label={`${context}: effort ${agentNames[agent]}`}
          value={profile.effort}
          onChange={(event) => onChange({ ...profile, effort: event.target.value })}
        >
          {!levels.includes(profile.effort) && <option value={profile.effort} disabled>{profile.effort} — недоступен для выбранной модели</option>}
          {levels.map((effort) => <option key={effort} value={effort}>{effort || (inherit ? "Общий effort провайдера" : "По умолчанию CLI")}</option>)}
        </select>
      </label>
    </>
  );
}

const events: { event: AgentDefaultEvent; label: string; hint?: string }[] = [
  { event: "startup", label: "При запуске VS Code", hint: "Для нового чата без сохранённой сессии." },
  { event: "newProject", label: "При создании проекта" },
  { event: "newChat", label: "При создании чата или сессии" },
];

export function AgentDefaultsSettings({ value, profiles, catalog, activeAgent, onChange, onProfileChange }: {
  value?: AgentDefaults;
  profiles: Record<AgentId, Profile>;
  catalog?: AgentModelCatalog;
  activeAgent: AgentId;
  onChange: (value: AgentDefaults) => void;
  onProfileChange: (agent: AgentId, profile: Profile) => void;
}) {
  const defaults = normalizeAgentDefaults(value);
  const updateRule = (event: AgentDefaultEvent, rule: AgentDefaultRule) => onChange({ ...defaults, [event]: rule });
  return (
    <section className="agent-defaults-settings">
      <h3>Агент, модель и effort по умолчанию</h3>
      <label className="set-row">
        <span>Провайдер</span>
        <select
          aria-label="Провайдер по умолчанию"
          value={defaults.provider}
          onChange={(event) => onChange({ ...defaults, provider: event.target.value as AgentDefaults["provider"] })}
        >
          <option value="lastUsed">Запоминать последний выбор</option>
          <option value="claude">Claude</option>
          <option value="codex">GPT (Codex)</option>
        </select>
      </label>
      <div className="set-hint">Общие модели и effort используются, когда в сессии нет собственного выбора. Можно выбрать модель из подсказок или ввести её идентификатор.</div>
      <div className="agent-default-profiles">
        {(["claude", "codex"] as const).map((agent) => (
          <fieldset className="agent-profile-editor" key={agent}>
            <legend>Общий профиль {agentNames[agent]}</legend>
            <ProfileFields agent={agent} profile={profiles[agent]} catalog={catalog} context="Общий профиль" inherit={false}
              onChange={(profile) => onProfileChange(agent, profile)} />
          </fieldset>
        ))}
      </div>
      <h4>Условия применения</h4>
      {events.map(({ event, label, hint }) => {
        const rule = defaults[event];
        return (
          <fieldset className="agent-default-rule" key={event}>
            <legend>{label}</legend>
            {hint && <div className="set-hint">{hint}</div>}
            <label className="set-row">
              <span>Правило</span>
              <select
                aria-label={`${label}: правило`}
                value={rule.mode}
                onChange={(input) => updateRule(event, input.target.value === "custom"
                  ? { mode: "custom", agent: defaults.provider === "lastUsed" ? activeAgent : defaults.provider, model: "", effort: "" }
                  : { mode: input.target.value as "preserve" | "default" })}
              >
                <option value="default">Общие настройки по умолчанию</option>
                <option value="preserve">Сохранить текущий / последний выбор</option>
                <option value="custom">Свой профиль для этого случая</option>
              </select>
            </label>
            {rule.mode === "custom" && (
              <>
                <label className="set-row">
                  <span>Провайдер</span>
                  <select aria-label={`${label}: провайдер`} value={rule.agent}
                    onChange={(input) => updateRule(event, { mode: "custom", agent: input.target.value as AgentId, model: "", effort: "" })}>
                    <option value="claude">Claude</option>
                    <option value="codex">GPT (Codex)</option>
                  </select>
                </label>
                <ProfileFields agent={rule.agent} profile={rule} catalog={catalog} context={label} inherit inheritedModel={profiles[rule.agent].model}
                  onChange={(profile) => updateRule(event, { ...rule, ...profile })} />
              </>
            )}
          </fieldset>
        );
      })}
      <div className="set-hint">Сохранённые чаты восстанавливаются со своими настройками. Новые правила применяются при создании проекта, чата или новой сессии.</div>
    </section>
  );
}
