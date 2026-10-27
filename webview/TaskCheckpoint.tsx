import { useEffect, useId, useRef, useState } from "react";
import type { HostToWebview, WebviewToHost } from "../src/shared/protocol";
import {
  emptyTaskFields, taskFields, validateTaskFields, TASK_FIELDS, TASK_FIELD_LABELS, TASK_FIELD_MAX_CHARS, TASK_TOTAL_MAX_CHARS,
  type TaskFields,
} from "../src/shared/taskState";

export type TaskSnapshot = Extract<HostToWebview, { type: "taskState" }>;
type SaveRequest = Extract<WebviewToHost, { type: "saveTaskState" }>;

/** The parent keys this editor by project, record and generation. */
export function TaskCheckpoint({ snapshot, disabled = false, hidden = false, onSave, onInsert }: {
  snapshot: TaskSnapshot;
  disabled?: boolean;
  hidden?: boolean;
  onSave: (request: SaveRequest) => void;
  onInsert: (fields: TaskFields) => void;
}) {
  const [fields, setFields] = useState<TaskFields>(() => snapshot.task ? taskFields(snapshot.task) : emptyTaskFields());
  const [baseRevision, setBaseRevision] = useState(snapshot.revision);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(snapshot.error);
  const [notice, setNotice] = useState("");
  const pendingRef = useRef<string | null>(null);
  const handledRef = useRef(snapshot);
  const hintId = useId();
  const conflict = dirty && snapshot.revision > baseRevision;
  const validation = validateTaskFields(fields);
  const total = TASK_FIELDS.reduce((sum, field) => sum + fields[field].length, 0);
  const hasText = TASK_FIELDS.some(field => fields[field].trim());

  useEffect(() => {
    if (handledRef.current === snapshot) return;
    handledRef.current = snapshot;
    const ownResponse = !!pendingRef.current && snapshot.requestId === pendingRef.current;
    if (ownResponse) {
      pendingRef.current = null;
      setPending(null);
    }
    if ((ownResponse || !snapshot.requestId) && snapshot.error) setError(snapshot.error);
    if ((ownResponse && !snapshot.error) || (!dirty && !pendingRef.current && snapshot.revision > baseRevision)) {
      setFields(snapshot.task ? taskFields(snapshot.task) : emptyTaskFields());
      setBaseRevision(snapshot.revision);
      setDirty(false);
      setError(snapshot.error);
      setNotice(ownResponse ? "Сохранено" : "");
    }
  }, [snapshot, dirty, baseRevision]);

  const save = (revision = baseRevision) => {
    if (disabled || pendingRef.current || validation || !snapshot.identity) return;
    const requestId = `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingRef.current = requestId;
    setPending(requestId);
    setError(undefined);
    setNotice("");
    onSave({ type: "saveTaskState", identity: snapshot.identity, revision, fields: { ...fields }, requestId });
  };

  return (
    <section className="task-checkpoint" aria-label="Заметки о задаче" hidden={hidden}>
      <details>
        <summary>
          <span>Задача · заметки</span>
          <span className="task-checkpoint-preview" title={fields.outcome}>{fields.outcome || "Добавить"}</span>
          {dirty && <span className="task-checkpoint-dirty" title="Есть несохранённые изменения" aria-label="Есть несохранённые изменения">●</span>}
        </summary>
        <div className="task-checkpoint-body">
          <p className="task-checkpoint-hint" id={hintId}>
            Ваши заметки для этого чата. Сохранение не отправляет их агенту. Записи не подтверждают проверки или готовность к выпуску и не дают разрешений на действия.
          </p>
          {TASK_FIELDS.map(field => (
            <label className="task-checkpoint-field" key={field}>
              <span>{TASK_FIELD_LABELS[field]}</span>
              <textarea
                value={fields[field]}
                rows={field === "outcome" || field === "nextStep" ? 2 : 1}
                maxLength={TASK_FIELD_MAX_CHARS}
                disabled={disabled || !!pending || !snapshot.identity}
                aria-describedby={hintId}
                onChange={event => {
                  setFields(previous => ({ ...previous, [field]: event.target.value }));
                  setDirty(true);
                  setNotice("");
                }}
              />
            </label>
          ))}
          <div className="task-checkpoint-hint">{total} / {TASK_TOTAL_MAX_CHARS} символов · до {TASK_FIELD_MAX_CHARS} в поле</div>
          {conflict && (
            <div className="task-checkpoint-conflict">
              <p>В другом представлении чата сохранена новая версия. Ваши правки оставлены в полях.</p>
              <details>
                <summary>Сохранённая версия</summary>
                <dl>{TASK_FIELDS.filter(field => snapshot.task?.[field]).map(field => (
                  <div key={field}><dt>{TASK_FIELD_LABELS[field]}</dt><dd>{snapshot.task![field]}</dd></div>
                ))}</dl>
              </details>
              <div className="task-checkpoint-actions">
                <button type="button" disabled={disabled || !!pending} onClick={() => {
                  setFields(snapshot.task ? taskFields(snapshot.task) : emptyTaskFields());
                  setBaseRevision(snapshot.revision);
                  setDirty(false);
                  setError(undefined);
                  setNotice("Загружена сохранённая версия");
                }}>Загрузить сохранённое</button>
                <button type="button" disabled={disabled || !!pending || !!validation} onClick={() => save(snapshot.revision)}>Сохранить моё</button>
              </div>
            </div>
          )}
          <div className="task-checkpoint-actions">
            <button type="button" disabled={disabled || !!pending || !dirty || !!validation || conflict || !snapshot.identity} onClick={() => save()}>Сохранить</button>
            <button type="button" disabled={disabled || !!pending || !hasText || !!validation || !snapshot.identity} onClick={() => {
              onInsert({ ...fields });
              setNotice("Добавлено в черновик сообщения");
            }}>Вставить в сообщение</button>
          </div>
          <div className="task-checkpoint-hint" role="status">{pending ? "Сохраняю…" : notice || (dirty ? "Не сохранено" : "")}</div>
        </div>
      </details>
      {(error || validation) && <div className="task-checkpoint-error" role="alert">{validation || error}</div>}
    </section>
  );
}
