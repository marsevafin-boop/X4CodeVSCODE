export interface ServerTestDraft {
  projectPath: string;
  host: string;
  user?: string;
  password?: string;
  protocol?: "ssh" | "sftp" | "ftp";
  port?: number;
}

export interface ServerTestState {
  status: "idle" | "pending" | "ok" | "fail";
  message: string;
  requestId?: string;
  projectPath?: string;
  fingerprint?: string;
}

interface ServerTestResult {
  requestId: string;
  projectPath: string;
  ok: boolean;
  message: string;
}

export const idleServerTest = (): ServerTestState => ({ status: "idle", message: "" });

/** In-memory comparison only: never persist or transmit this password-bearing key. */
export function serverTestFingerprint(draft: ServerTestDraft | null): string | null {
  if (!draft) return null;
  return JSON.stringify([
    draft.projectPath, draft.host, draft.user, draft.port, draft.protocol ?? "ssh",
    draft.password,
  ]);
}

export function beginServerTest(draft: ServerTestDraft, requestId: string): ServerTestState {
  return {
    status: "pending", message: "", requestId, projectPath: draft.projectPath,
    fingerprint: serverTestFingerprint(draft)!,
  };
}

export function reconcileServerTest(state: ServerTestState, draft: ServerTestDraft | null): ServerTestState {
  if (state.status === "idle") return state;
  return draft && state.fingerprint === serverTestFingerprint(draft) ? state : idleServerTest();
}

export function finishServerTest(
  state: ServerTestState, result: ServerTestResult, draft: ServerTestDraft | null,
): ServerTestState {
  const current = reconcileServerTest(state, draft);
  if (current.status !== "pending" || current.requestId !== result.requestId ||
    current.projectPath !== result.projectPath) return current;
  return { ...current, status: result.ok ? "ok" : "fail", message: result.message };
}
