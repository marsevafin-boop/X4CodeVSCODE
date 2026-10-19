import type { AgentBackend, AgentEvent, StartOptions } from "./types";

export class CodexWriterRecoveryBackend implements AgentBackend {
  readonly id = "codex";

  constructor(private readonly primary: AgentBackend, private readonly appServer: AgentBackend) {}

  async *start(prompt: string, opts: StartOptions): AsyncIterable<AgentEvent> {
    let materialOutput = false;
    let writerConflict = false;
    for await (const event of this.primary.start(prompt, opts)) {
      if (event.kind === "textDelta" || event.kind === "assistantText" || event.kind === "toolUse" || event.kind === "question") {
        materialOutput = true;
      }
      if (!materialOutput && event.kind === "error" && event.code === "codexWriterConflict") {
        writerConflict = true;
        continue;
      }
      if (writerConflict && !materialOutput && event.kind === "result" && !event.ok) continue;
      yield event;
    }
    // Exhausting the primary iterator also awaits its finally/child cleanup.
    // A thrown cleanup error propagates without starting a second backend.
    if (!writerConflict || materialOutput || opts.signal.aborted) return;
    yield {
      kind: "notice",
      text: "⚠️ Тред Codex занят другим процессом. Переключаю этот запуск с exec на app-server для восстановления продолжения.",
    };
    if (opts.signal.aborted) return;
    yield* this.appServer.start(prompt, opts);
  }
}
