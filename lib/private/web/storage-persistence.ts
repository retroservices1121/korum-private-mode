/**
 * Asking the browser not to clear Private Mode data.
 *
 * Best-effort storage can be evicted under disk pressure, and eviction takes
 * the whole origin: model and chats. `navigator.storage.persist()` asks for
 * an exemption. Rules:
 *   - `persisted()` is checked on load (no prompt, no side effects);
 *   - `persist()` is requested at three moments only: when a WebLLM model
 *     download starts (an opt-in upgrade), when a model finishes setting up,
 *     and when the first chat is saved — each at most ONCE per session, and
 *     never again once granted. No retry loop.
 *   - the result drives the status line and, when not protected, a nudge to
 *     export chats.
 * No network: these are local browser APIs.
 */

export type PersistState = "checking" | "persisted" | "not_persisted" | "unsupported";
export type PersistTrigger = "model_download_started" | "model_ready" | "first_chat_saved";

export interface StorageManagerLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

export const PERSIST_COPY = {
  persisted: "Protected from automatic clearing",
  notPersisted: "Your browser may clear this data",
  nudge: "Export chats you want to keep.",
} as const;

export class StoragePersistence {
  private state: PersistState = "checking";
  private asked = new Set<PersistTrigger>();
  /** Bumped when a request() settles; a check() that started earlier is stale. */
  private requestEpoch = 0;
  private listeners = new Set<() => void>();

  constructor(
    private readonly storage: StorageManagerLike | undefined = (
      globalThis.navigator as unknown as { storage?: StorageManagerLike } | undefined
    )?.storage,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): PersistState => this.state;

  private set(state: PersistState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /**
   * Reads the current status without asking for anything.
   *
   * Startup does not await this, so a request() can settle first. A check that started before a request settled is stale:
   * its result is dropped unless it is "persisted" (good news is always a
   * fact). A grant is never downgraded by a late check.
   */
  async check(): Promise<PersistState> {
    if (!this.storage?.persisted) {
      if (this.state === "checking") this.set(this.storage?.persist ? "not_persisted" : "unsupported");
      return this.state;
    }
    const epoch = this.requestEpoch;
    let result: PersistState;
    try {
      result = (await this.storage.persisted()) ? "persisted" : "not_persisted";
    } catch {
      result = "not_persisted";
    }
    const stale = epoch !== this.requestEpoch;
    if (this.state === "persisted" || (stale && result !== "persisted")) return this.state;
    this.set(result);
    return this.state;
  }

  /** Asks once per trigger per session, and never after it was granted. */
  async request(trigger: PersistTrigger): Promise<PersistState> {
    if (this.state === "persisted" || this.state === "unsupported") return this.state;
    if (this.asked.has(trigger)) return this.state;
    this.asked.add(trigger);
    if (!this.storage?.persist) {
      this.set("unsupported");
      return this.state;
    }
    let result: PersistState;
    try {
      result = (await this.storage.persist()) ? "persisted" : "not_persisted";
    } catch {
      result = "not_persisted";
    }
    this.requestEpoch++;
    // A concurrent check may already have seen "persisted"; never downgrade it.
    if (this.getState() !== "persisted") this.set(result);
    return this.state;
  }
}
