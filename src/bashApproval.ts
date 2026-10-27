type ValueOption = { pattern: RegExp; separate?: boolean };
type CommandPolicy = {
  baseLength: number;
  flags: ReadonlySet<string>;
  values: Readonly<Record<string, ValueOption>>;
  shortFlags: RegExp;
};

const count: ValueOption = { pattern: /^\d+$/, separate: true };
const color: ValueOption = { pattern: /^(always|auto|never)$/ };

const statusPolicy: CommandPolicy = {
  baseLength: 2,
  flags: new Set([
    "--short", "--branch", "--long", "--porcelain", "--show-stash", "--null",
    "--untracked-files", "--ignored", "--ignore-submodules", "--renames", "--no-renames",
    "--ahead-behind", "--no-ahead-behind", "-u", "-uno", "-unormal", "-uall",
  ]),
  values: {
    "--porcelain": { pattern: /^(v1|v2)$/ },
    "--untracked-files": { pattern: /^(no|normal|all)$/ },
    "--ignored": { pattern: /^(traditional|matching|no)$/ },
    "--ignore-submodules": { pattern: /^(none|untracked|dirty|all)$/ },
  },
  shortFlags: /^-[sbz]+$/,
};

const diffPolicy: CommandPolicy = {
  baseLength: 2,
  flags: new Set([
    "--stat", "--numstat", "--shortstat", "--name-only", "--name-status",
    "--cached", "--staged", "--quiet", "--exit-code", "--check", "--patch", "--no-patch",
    "--no-ext-diff", "--no-textconv", "--no-renames", "--color", "--no-color",
    "--ignore-space-at-eol", "--ignore-space-change", "--ignore-all-space", "--ignore-blank-lines",
  ]),
  values: {
    "--unified": count,
    "-U": count,
    "--color": color,
    "--diff-filter": { pattern: /^[ACDMRTUXBacdmrtuxb]+$/ },
  },
  shortFlags: /^(?:-[psuwb]+|-U\d+)$/,
};

const logPolicy: CommandPolicy = {
  baseLength: 2,
  flags: new Set([
    "--oneline", "--graph", "--decorate", "--no-decorate", "--all", "--branches", "--tags", "--remotes",
    "--no-merges", "--merges", "--first-parent", "--reverse", "--date-order", "--author-date-order",
    "--topo-order", "--abbrev-commit", "--no-abbrev-commit", "--no-walk", "--no-show-signature",
    "--no-ext-diff", "--no-textconv", "--color", "--no-color", "--stat", "--name-only", "--name-status",
  ]),
  values: {
    "--max-count": count,
    "-n": count,
    "--decorate": { pattern: /^(short|full|auto|no)$/ },
    "--color": color,
  },
  shortFlags: /^-(?:n?\d+)$/,
};

const lsPolicy: CommandPolicy = {
  baseLength: 1,
  flags: new Set([
    "--all", "--almost-all", "--directory", "--human-readable", "--recursive", "--reverse",
    "--size", "--inode", "--numeric-uid-gid", "--classify",
  ]),
  values: {
    "--color": color,
    "--sort": { pattern: /^(none|size|time|version|extension)$/ },
  },
  shortFlags: /^-[aAhlRdrStucin1FHGPL]+$/,
};

/** Parse only unquoted ASCII literals. Unsupported shell syntax always asks. */
function literalTokens(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_./:@%+=,\- \t]+$/.test(value)) return undefined;
  const tokens = value.replace(/^[ \t]+|[ \t]+$/g, "").split(/[ \t]+/);
  // An environment assignment is shell syntax, not a literal executable name.
  if (!tokens[0] || !/^[A-Za-z0-9_./-]+$/.test(tokens[0])) return undefined;
  return tokens;
}

function policyFor(tokens: readonly string[]): CommandPolicy | undefined {
  if (tokens[0] === "ls") return lsPolicy;
  if (tokens[0] !== "git") return undefined;
  switch (tokens[1]) {
    case "status": return statusPolicy;
    case "diff": return diffPolicy;
    case "log": return logPolicy;
    default: return undefined;
  }
}

function knownArguments(tokens: readonly string[], policy: CommandPolicy): boolean {
  for (let index = policy.baseLength; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--") return true;
    if (!token.startsWith("-")) continue;
    if (policy.flags.has(token) || policy.shortFlags.test(token)) continue;
    const equals = token.indexOf("=");
    const name = equals < 0 ? token : token.slice(0, equals);
    const option = Object.hasOwn(policy.values, name) ? policy.values[name] : undefined;
    if (!option) return false;
    const value = equals < 0 && option.separate ? tokens[++index] : token.slice(equals + 1);
    if ((equals < 0 && !option.separate) || value === undefined || !option.pattern.test(value)) return false;
  }
  return true;
}

/**
 * Decide whether a configured rule covers one literal command. Only the four
 * built-in base rules expand to known options and operands; other rules match
 * their complete token sequence. This is an approval filter, not a sandbox:
 * executable lookup and tool configuration remain outside its guarantees.
 */
export function isBashAutoAllowed(command: unknown, rules: unknown): boolean {
  const tokens = literalTokens(command);
  if (!tokens || !Array.isArray(rules) || rules.length === 0) return false;
  const policy = policyFor(tokens);
  if (policy && !knownArguments(tokens, policy)) return false;

  let matched = false;
  for (const rule of rules) {
    const ruleTokens = literalTokens(rule);
    if (!ruleTokens) return false;
    const rulePolicy = policyFor(ruleTokens);
    if (rulePolicy && !knownArguments(ruleTokens, rulePolicy)) return false;
    if (ruleTokens.length > tokens.length || !ruleTokens.every((token, index) => token === tokens[index])) continue;
    if (ruleTokens.length === tokens.length || (rulePolicy && ruleTokens.length === rulePolicy.baseLength)) matched = true;
  }
  return matched;
}
