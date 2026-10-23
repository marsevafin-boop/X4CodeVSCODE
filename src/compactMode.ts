/** Native layout commands are serialized independently from chat and run mutations. */
export interface CompactModeState {
  enabled: boolean;
  pending: boolean;
  error?: string;
}

interface CompactModeDependencies {
  readEnabled(): boolean;
  writeEnabled(enabled: boolean): PromiseLike<void>;
  executeCommand(command: string): PromiseLike<unknown>;
  centersLayout(): boolean;
  publish(state: CompactModeState): void;
}

const EXIT_ZEN = "workbench.action.exitZenMode";
const ENTER_ZEN = "workbench.action.toggleZenMode";
const CENTER_LAYOUT = "workbench.action.toggleCenteredLayout";

/** Owns Zen only while a multichat panel is attached; never edits workbench settings. */
export class CompactModeController {
  private enabled: boolean;
  private pending = false;
  private error?: string;
  private owner?: object;
  private nativeActive = false;
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: CompactModeDependencies) {
    this.enabled = dependencies.readEnabled() === true;
  }

  get state(): CompactModeState {
    return { enabled: this.enabled, pending: this.pending, ...(this.error ? { error: this.error } : {}) };
  }

  private publish() { this.dependencies.publish(this.state); }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.mutation.then(operation);
    this.mutation = next.catch(() => {});
    return next;
  }

  private async enterNative() {
    // There is no public enterZenMode command or readable Zen state. Exit first
    // makes entry deterministic even when the user had already entered Zen.
    await this.dependencies.executeCommand(EXIT_ZEN);
    this.nativeActive = false;
    // A rejected toggle may still have changed native layout; retain ownership
    // until an idempotent exit confirms that cleanup completed.
    this.nativeActive = true;
    await this.dependencies.executeCommand(ENTER_ZEN);
    if (this.dependencies.centersLayout()) await this.dependencies.executeCommand(CENTER_LAYOUT);
  }

  private async exitNative() {
    await this.dependencies.executeCommand(EXIT_ZEN);
    this.nativeActive = false;
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** Applies a saved preference once, regardless of repeated webview readiness. */
  attach(owner: object): Promise<void> {
    if (this.owner === owner) return this.serialize(async () => { this.publish(); });
    this.owner = owner;
    return this.serialize(async () => {
      if (this.owner !== owner) return;
      if (!this.enabled) { this.publish(); return; }
      this.pending = true; this.error = undefined; this.publish();
      try {
        await this.enterNative();
      } catch (error) {
        this.error = this.describe(error);
        if (this.nativeActive) {
          try { await this.exitNative(); }
          catch (cleanup) { this.error += `; ${this.describe(cleanup)}`; }
        }
        // Keep the saved preference and dense controls available for retry/exit.
      } finally {
        this.pending = false; this.publish();
      }
    });
  }

  /** Closing restores native bars but keeps the preference for the next open. */
  detach(owner: object): Promise<void> {
    if (this.owner !== owner) return this.serialize(async () => {});
    this.owner = undefined;
    return this.serialize(async () => {
      // A replacement panel takes ownership before queued cleanup can run.
      if (this.owner) return;
      if (!this.nativeActive) { this.publish(); return; }
      this.pending = true; this.error = undefined; this.publish();
      try { await this.exitNative(); }
      catch (error) { this.error = this.describe(error); }
      finally { this.pending = false; this.publish(); }
    });
  }

  setEnabled(enabled: boolean): Promise<void> {
    const owner = this.owner;
    return this.serialize(() => this.applyEnabled(enabled, owner));
  }

  /** Compute inversion inside the queue so repeated palette commands stay ordered. */
  toggle(): Promise<void> {
    const owner = this.owner;
    return this.serialize(() => this.applyEnabled(!this.enabled, owner));
  }

  private async applyEnabled(enabled: boolean, owner: object | undefined): Promise<void> {
    if (this.owner !== owner || (enabled && !owner)) return;
    if (enabled === this.enabled && enabled === this.nativeActive && !this.error) { this.publish(); return; }
    const previous = this.enabled;
    this.pending = true; this.error = undefined; this.publish();
    try {
      if (enabled) await this.enterNative();
      else await this.exitNative();
      await this.dependencies.writeEnabled(enabled);
      this.enabled = enabled;
    } catch (error) {
      this.error = this.describe(error);
      if (enabled) {
        if (this.nativeActive) {
          try { await this.exitNative(); }
          catch (cleanup) { this.error += `; ${this.describe(cleanup)}`; }
        }
        this.enabled = previous || this.nativeActive;
      } else {
        // A storage failure after exit must restore the enabled native layout
        // to match the preference that remains on disk. A failed native exit
        // already retains ownership and needs no additional toggle.
        if (previous && !this.nativeActive) {
          try { await this.enterNative(); }
          catch (cleanup) { this.error += `; ${this.describe(cleanup)}`; }
        }
        this.enabled = previous || this.nativeActive;
      }
    } finally {
      this.pending = false; this.publish();
    }
  }
}
