/**
 * Private chat controller: the whole send / stream / regenerate / thumbs /
 * copy / export flow, with no React and no network. The UI subscribes to it;
 * tests drive it directly with a mock `LocalProvider` and fake IndexedDB.
 *
 * Every dependency is injected. The only side effects are the provider (local
 * inference), the store (IndexedDB) and the clipboard. There is deliberately
 * no fetch, no analytics and no error reporting in here.
 */

import type { AIMessage } from "@/lib/ai/types";
import { deriveTitle } from "@/lib/chat/title";
import { localBudget, tooLongMessage } from "@/lib/private/core/context-budget";
import {
  LocalRuntimeError,
  type ModelDescriptorBase,
  type LocalProvider,
  type LocalRuntimeId,
} from "@/lib/private/core/local-provider";
import { ThinkFilter } from "@/lib/private/core/think-filter";
import { threadToJSON, threadToMarkdown, exportFileName } from "@/lib/private/core/thread-export";
import {
  SCHEMA_VERSION,
  ulid,
  type LocalMessage,
  type LocalThread,
  type ProfileKey,
  type ThreadStore,
} from "@/lib/private/core/thread-schema";

export const PRIVATE_SYSTEM_PROMPT = [
  "You are KORUM's private assistant, running entirely on the user's own device.",
  "Answer the question that was asked, and lead with the answer. Keep answers concise.",
  "Use markdown for structure and fenced code blocks for code. Do not include images.",
  "Say plainly when you are unsure or do not know.",
].join("\n");

export const MAX_OUTPUT_TOKENS = 1024;
/** How often a streaming reply is written to IndexedDB. */
export const FLUSH_INTERVAL_MS = 400;

/**
 * "ignored": nothing to do (empty, already streaming, no model) — the caller
 * keeps the draft. "save_failed": the prompt could not be stored on this
 * device and was not sent to the model. Content-free by design.
 */
export type SendResult = { status: "sent" } | { status: "ignored" } | { status: "save_failed" };

export const SAVE_FAILED_MESSAGE =
  "Couldn't save to this device, so your message wasn't sent. Your browser may be out of storage space. Your text is back in the box.";

/** Same failure, when the box already holds something newer: the text is kept behind an action. */
export const SAVE_FAILED_KEPT_MESSAGE =
  "Couldn't save to this device, so your message wasn't sent. Your browser may be out of storage space.";

export interface PrivateChatState {
  threads: LocalThread[];
  activeThreadId: string | null;
  messages: LocalMessage[];
  streamingId: string | null;
  turnInProgress: boolean;
  /** Set when an existing install had messages cut off by a closed tab. */
  recoveredInterrupted: number;
}

/** Any on-device runtime: the controller only counts tokens and streams. */
export type ChatProvider = LocalProvider<ModelDescriptorBase>;

export interface ControllerDeps {
  /** The initial engine; `setModel(model, provider)` can switch it. */
  provider: ChatProvider;
  store: ThreadStore;
  profileKey: ProfileKey;
  deviceId: string;
  writeClipboard: (text: string) => Promise<void>;
  now?: () => number;
  /** A user message was written to this device (used to request persistent storage). */
  onUserMessageSaved?: () => void;
  /** Runtime failures during generation (e.g. device lost), kind only, with the engine that failed. */
  onRuntimeError?: (error: LocalRuntimeError, provider: LocalRuntimeId) => void;
}

const ERROR_TEXT: Partial<Record<LocalRuntimeError["kind"], string>> = {
  device_lost: "The on-device model stopped (the GPU was reset). Reload the model and try again.",
  out_of_memory: "The on-device model ran out of memory. Try a lighter model.",
  not_loaded: "The on-device model is not loaded yet.",
};

export class PrivateChatController {
  private state: PrivateChatState = {
    threads: [],
    activeThreadId: null,
    messages: [],
    streamingId: null,
    turnInProgress: false,
    recoveredInterrupted: 0,
  };
  private listeners = new Set<() => void>();
  private model: ModelDescriptorBase | null = null;
  private provider: ChatProvider;
  /**
   * The one in-flight generation. It owns its message record, so its final
   * write never depends on which thread is on screen.
   */
  private gen: {
    id: number;
    threadId: string;
    messageId: string;
    abort: AbortController;
    done: Promise<void>;
  } | null = null;
  private nextGenId = 1;
  /** Threads deleted this session: a late write must never resurrect them. */
  private deletedThreads = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.provider = deps.provider;
  }

  // ------------------------------------------------------------ subscription
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): PrivateChatState => this.state;

  private set(patch: Partial<PrivateChatState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private patchMessage(id: string, patch: Partial<LocalMessage>): LocalMessage | undefined {
    let updated: LocalMessage | undefined;
    this.set({
      messages: this.state.messages.map((m) => {
        if (m.id !== id) return m;
        updated = { ...m, ...patch, updatedAt: this.now() };
        return updated;
      }),
    });
    return updated;
  }

  // ------------------------------------------------------------------ setup
  /**
   * Sets the model for the NEXT generation, optionally on another engine
   * (built-in model ↔ WebLLM tier). An in-flight generation keeps the engine
   * it started on.
   */
  setModel(model: ModelDescriptorBase | null, provider?: ChatProvider) {
    this.model = model;
    if (provider) this.provider = provider;
  }

  /** The id of the model the next generation would use. */
  get modelId(): string | null {
    return this.model?.id ?? null;
  }

  async init(): Promise<void> {
    const recovered = await this.deps.store.recoverInterrupted();
    const threads = await this.deps.store.listThreads(this.deps.profileKey);
    this.set({ threads, recoveredInterrupted: recovered });
  }

  /** Cancels the in-flight generation and waits until its final state is persisted. */
  private async settleGeneration(): Promise<void> {
    const gen = this.gen;
    if (!gen) return;
    gen.abort.abort();
    await gen.done;
  }

  /**
   * Bumped whenever the user moves to another thread (new, select, delete
   * the open one). Lets async callers tell whether the view they started
   * from is still on screen.
   */
  get viewVersion(): number {
    return this.viewCounter;
  }
  private viewCounter = 0;

  async newThread(): Promise<void> {
    this.viewCounter++;
    await this.settleGeneration();
    this.set({ activeThreadId: null, messages: [] });
  }

  async selectThread(id: string): Promise<void> {
    this.viewCounter++;
    await this.settleGeneration();
    const messages = await this.deps.store.listMessages(id);
    this.set({ activeThreadId: id, messages });
  }

  async deleteThread(id: string): Promise<void> {
    // Mark first, so a generation finishing during the await cannot write back.
    this.deletedThreads.add(id);
    if (this.state.activeThreadId === id) this.viewCounter++;
    if (this.gen?.threadId === id) await this.settleGeneration();
    await this.deps.store.deleteThread(id);
    const threads = this.state.threads.filter((t) => t.id !== id);
    this.set(
      this.state.activeThreadId === id
        ? { threads, activeThreadId: null, messages: [] }
        : { threads },
    );
  }

  private async ensureThread(firstMessage: string): Promise<LocalThread> {
    const existing = this.state.threads.find((t) => t.id === this.state.activeThreadId);
    if (existing) {
      const touched = { ...existing, updatedAt: this.now() };
      await this.deps.store.putThread(touched);
      this.set({ threads: [touched, ...this.state.threads.filter((t) => t.id !== touched.id)] });
      return touched;
    }
    const at = this.now();
    const thread: LocalThread = {
      id: ulid(at),
      schemaVersion: SCHEMA_VERSION,
      profileKey: this.deps.profileKey,
      deviceId: this.deps.deviceId,
      title: deriveTitle(firstMessage),
      createdAt: at,
      updatedAt: at,
    };
    await this.deps.store.putThread(thread);
    this.set({ threads: [thread, ...this.state.threads], activeThreadId: thread.id });
    return thread;
  }

  private newMessage(
    threadId: string,
    role: LocalMessage["role"],
    content: string,
    at: number,
    status: LocalMessage["status"],
    localModel?: string,
  ): LocalMessage {
    return {
      id: ulid(at),
      threadId,
      schemaVersion: SCHEMA_VERSION,
      deviceId: this.deps.deviceId,
      role,
      content,
      origin: "local",
      ...(localModel ? { localModel } : {}),
      status,
      createdAt: at,
      updatedAt: at,
    };
  }

  /** History sent to the local model: failed turns (and their question) are left out. */
  private historyFor(messages: LocalMessage[]): AIMessage[] {
    const out: AIMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const next = messages[i + 1];
      if (m.status === "error" || m.status === "streaming") continue;
      if (m.role === "user" && next?.role === "assistant" && next.status === "error") continue;
      if (m.role === "assistant" && m.content.trim() === "") continue;
      out.push({ role: m.role, content: m.content });
    }
    return out;
  }

  // ---------------------------------------------------------------- sending
  /**
   * Saves the prompt, then answers it. Resolves `saved: false` when the
   * prompt could not be written to this device (e.g. IndexedDB quota): the
   * prompt is then NOT in the transcript, and the caller must give it back to
   * the user rather than lose it. Never rejects for that.
   */
  async send(text: string): Promise<SendResult> {
    const trimmed = text.trim();
    if (!trimmed) return { status: "ignored" };
    const { model, provider } = this;
    if (this.state.turnInProgress || !model) return { status: "ignored" };

    this.set({ turnInProgress: true });
    try {
      let thread: LocalThread;
      let user: LocalMessage;
      try {
        thread = await this.ensureThread(trimmed);
        user = this.newMessage(thread.id, "user", trimmed, this.now(), "complete");
        await this.deps.store.putMessage(user);
      } catch {
        return { status: "save_failed" };
      }
      this.set({ messages: [...this.state.messages, user] });
      this.deps.onUserMessageSaved?.();
      await this.generate(thread.id, model, provider);
      return { status: "sent" };
    } finally {
      this.set({ turnInProgress: false });
    }
  }

  async regenerate(): Promise<void> {
    const { model, provider } = this;
    const { activeThreadId, messages, turnInProgress } = this.state;
    if (turnInProgress || !model || !activeThreadId) return;
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return;

    this.set({ turnInProgress: true });
    try {
      await this.deps.store.deleteMessage(last.id);
      this.set({ messages: this.state.messages.slice(0, -1) });
      await this.generate(activeThreadId, model, provider);
    } finally {
      this.set({ turnInProgress: false });
    }
  }

  stop(): void {
    this.gen?.abort.abort();
  }

  /** Model capacity failures disable the model; the app decides the step-down. */
  private static isCapacityFailure(error: LocalRuntimeError): boolean {
    return error.isLoadCapacityFailure || error.kind === "not_loaded" || error.kind === "worker_failed";
  }

  private generate(
    threadId: string,
    model: ModelDescriptorBase,
    provider: ChatProvider,
  ): Promise<void> {
    // Cancellation exists before any async step, so Stop works during
    // token counting too.
    const abort = new AbortController();
    const genId = this.nextGenId++;
    const history = this.historyFor(this.state.messages);
    const at = Math.max(this.now(), (this.state.messages.at(-1)?.createdAt ?? 0) + 1);
    let record = this.newMessage(threadId, "assistant", "", at, "streaming", model.id);

    const visible = () => this.gen?.id === genId && this.state.activeThreadId === threadId;
    const update = (patch: Partial<LocalMessage>) => {
      record = { ...record, ...patch, updatedAt: this.now() };
      if (visible()) {
        this.set({ messages: this.state.messages.map((m) => (m.id === record.id ? record : m)) });
      }
    };
    const persist = async () => {
      if (this.deletedThreads.has(threadId)) return;
      await this.deps.store.putMessage(record);
    };

    this.set({ messages: [...this.state.messages, record], streamingId: record.id });

    const run = async () => {
      let content = "";
      // Only the WebLLM tiers (Qwen3) can emit `<think>` blocks.
      const filter = provider.id === "webllm" ? new ThinkFilter() : null;
      try {
        await persist();

        let counts: number[] | null = null;
        try {
          counts = await provider.countTokens([
            PRIVATE_SYSTEM_PROMPT,
            ...history.map((m) => m.content),
          ]);
        } catch {
          counts = null; // fall back to the conservative estimate
        }
        if (abort.signal.aborted) {
          // Stopped before inference started: drop the empty placeholder.
          if (!this.deletedThreads.has(threadId)) await this.deps.store.deleteMessage(record.id);
          if (visible()) this.set({ messages: this.state.messages.filter((m) => m.id !== record.id) });
          return;
        }

        const budget = localBudget({
          system: PRIVATE_SYSTEM_PROMPT,
          history,
          contextWindowTokens: model.contextWindowTokens,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          counts,
        });
        if (!budget.ok) {
          update({
            status: "error",
            errorKind: "context_exceeded",
            content: tooLongMessage(budget.messageTokens, budget.limitTokens),
          });
          await persist();
          return;
        }

        let lastFlush = this.now();
        try {
          for await (const chunk of provider.stream({
            messages: budget.messages,
            maxTokens: MAX_OUTPUT_TOKENS,
            signal: abort.signal,
          })) {
            if (chunk.type !== "text") continue;
            const shown = filter ? filter.push(chunk.text) : chunk.text;
            if (!shown) continue;
            content += shown;
            update({ content });
            if (this.now() - lastFlush >= FLUSH_INTERVAL_MS) {
              lastFlush = this.now();
              await persist();
            }
          }
          content += filter?.flush() ?? "";
          update({ content, status: "complete" });
        } catch (error) {
          content += filter?.flush() ?? "";
          if (abort.signal.aborted) {
            update({ content, status: "complete" });
          } else {
            const runtime =
              error instanceof LocalRuntimeError ? error : new LocalRuntimeError("unknown");
            if (runtime.kind === "context_exceeded") {
              update({
                content:
                  "This conversation is too long for the on-device model. Start a new chat, or shorten your message.",
                status: "error",
                errorKind: runtime.kind,
              });
            } else {
              if (PrivateChatController.isCapacityFailure(runtime) && this.model === model) this.model = null;
              update({
                content:
                  content || (ERROR_TEXT[runtime.kind] ?? "The on-device model could not answer that."),
                status: content ? "interrupted" : "error",
                errorKind: runtime.kind,
              });
            }
            this.deps.onRuntimeError?.(runtime, provider.id);
          }
        }
        await persist();
      } catch {
        // Storage failed. Keep the visible answer; it cannot be saved.
        if (record.status === "streaming") update({ status: "interrupted" });
      } finally {
        if (this.gen?.id === genId) {
          this.gen = null;
          this.set({ streamingId: null });
        }
      }
    };

    const done = run();
    this.gen = { id: genId, threadId, messageId: record.id, abort, done };
    return done;
  }

  // ----------------------------------------------------- local-only actions
  async setThumb(messageId: string, thumb: "up" | "down" | null): Promise<void> {
    const updated = this.patchMessage(messageId, { thumb });
    if (updated) await this.deps.store.putMessage(updated);
  }

  async copy(messageId: string): Promise<void> {
    const message = this.state.messages.find((m) => m.id === messageId);
    if (message) await this.deps.writeClipboard(message.content);
  }

  async exportActive(
    format: "json" | "md",
  ): Promise<{ fileName: string; text: string; mime: string } | null> {
    const thread = this.state.threads.find((t) => t.id === this.state.activeThreadId);
    if (!thread) return null;
    const messages = await this.deps.store.listMessages(thread.id);
    return format === "json"
      ? { fileName: exportFileName(thread, "json"), text: threadToJSON(thread, messages), mime: "application/json" }
      : { fileName: exportFileName(thread, "md"), text: threadToMarkdown(thread, messages), mime: "text/markdown" };
  }
}
