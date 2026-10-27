/** User-authored notes only: never an automatic prompt or a permission grant. */
export const TASK_FIELDS = [
  "outcome", "scope", "doneWhen", "requiredChecks", "candidate", "completed", "blockers", "nextStep", "evidence",
] as const;
export type TaskField = typeof TASK_FIELDS[number];
export type TaskFields = Record<TaskField, string>;
export const TASK_FIELD_MAX_CHARS = 2_000;
export const TASK_TOTAL_MAX_CHARS = 12_000;
export const TASK_INSERT_MAX_CHARS = 13_000;
export const TASK_FIELD_LABELS: Record<TaskField, string> = {
  outcome: "Результат", scope: "Объём", doneWhen: "Критерии готовности", requiredChecks: "Нужные проверки",
  candidate: "Текущий вариант", completed: "Сделано", blockers: "Препятствия", nextStep: "Следующий шаг", evidence: "Свидетельства и ссылки",
};

export interface TaskState extends TaskFields {
  schemaVersion: 1;
  revision: number;
  updatedAt: number;
}

export interface TaskIdentity {
  projectKey: string;
  recordId: string;
  createdAt: number;
}

export function emptyTaskFields(): TaskFields {
  return { outcome: "", scope: "", doneWhen: "", requiredChecks: "", candidate: "", completed: "", blockers: "", nextStep: "", evidence: "" };
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

/** Reject rather than truncate so storage and the editor always agree. Limits are UTF-16 code units, like textarea.maxLength. */
export function validateTaskFields(value: unknown): string | undefined {
  if (!object(value) || !exactKeys(value, TASK_FIELDS)) return "Некорректные поля заметок. Обновите чат.";
  let total = 0;
  for (const field of TASK_FIELDS) {
    const text = value[field];
    if (typeof text !== "string") return "Все поля заметок должны быть текстом.";
    if (text.length > TASK_FIELD_MAX_CHARS) return `Поле «${TASK_FIELD_LABELS[field]}»: максимум ${TASK_FIELD_MAX_CHARS} символов.`;
    total += text.length;
  }
  if (total > TASK_TOTAL_MAX_CHARS) return `В заметках максимум ${TASK_TOTAL_MAX_CHARS} символов суммарно.`;
  return undefined;
}

export function taskFields(state: TaskFields): TaskFields {
  return Object.fromEntries(TASK_FIELDS.map(field => [field, state[field]])) as TaskFields;
}

export function isTaskState(value: unknown): value is TaskState {
  if (!object(value) || !exactKeys(value, [...TASK_FIELDS, "schemaVersion", "revision", "updatedAt"])) return false;
  return value.schemaVersion === 1 && Number.isSafeInteger(value.revision) && (value.revision as number) > 0 &&
    Number.isSafeInteger(value.updatedAt) && (value.updatedAt as number) >= 0 &&
    validateTaskFields(taskFields(value as unknown as TaskFields)) === undefined;
}

export function isTaskIdentity(value: unknown): value is TaskIdentity {
  if (!object(value) || !exactKeys(value, ["projectKey", "recordId", "createdAt"])) return false;
  return typeof value.projectKey === "string" && value.projectKey.length > 0 && value.projectKey.length <= 4_096 &&
    typeof value.recordId === "string" && value.recordId.length > 0 && value.recordId.length <= 512 &&
    Number.isSafeInteger(value.createdAt) && (value.createdAt as number) >= 0;
}

export function hasTaskContent(value: unknown): boolean {
  return isTaskState(value) && TASK_FIELDS.some(field => value[field].trim().length > 0);
}

/** Unknown saved formats are data to retain, not proof that a conversation is empty. */
export function shouldPreserveTask(value: unknown): boolean {
  return value !== undefined && (!isTaskState(value) || hasTaskContent(value));
}

/** Called only by the explicit insert button; no host/model request is involved. */
export function formatTaskCheckpoint(value: unknown): string {
  if (validateTaskFields(value)) return "";
  const fields = value as TaskFields;
  const sections = TASK_FIELDS.filter(field => fields[field].trim()).map(field => `${TASK_FIELD_LABELS[field]}:\n${fields[field]}`);
  if (!sections.length) return "";
  return ["Заметки пользователя о задаче. Они не подтверждают выполнение проверок или готовность к выпуску и не дают разрешений на действия.", ...sections].join("\n\n");
}

export function appendTaskCheckpoint(draft: string, value: unknown): string {
  const notes = formatTaskCheckpoint(value);
  return notes ? (draft ? `${draft}\n\n${notes}` : notes) : draft;
}
