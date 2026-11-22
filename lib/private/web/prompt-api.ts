/**
 * The model built into the browser, through the Prompt API (`LanguageModel`).
 *
 *   - Chrome 148+ desktop: Gemini Nano, downloaded separately by Chrome
 *     the first time an origin uses the API.
 *     https://developer.chrome.com/docs/ai/prompt-api
 *   - Edge: a built-in model in developer preview. Edge 158 or later uses
 *     Aion Instruct.
 *     KORUM registers no origin trial; Edge is supported by feature detection.
 *     https://learn.microsoft.com/en-us/microsoft-edge/web-platform/prompt-api
 *
 * The explainer (github.com/webmachinelearning/prompt-api) lets a browser
 * implement the API with a cloud service, and pages cannot tell. So the API
 * is used ONLY when the browser identifies as Google Chrome or Microsoft
 * Edge, whose vendors document on-device inference. Anything else that
 * exposes `LanguageModel` is reported "unverified" and never used.
 *
 * Main thread only (the API is not exposed to workers). This module makes no
 * network request: inference happens inside the browser. It never passes
 * `samplingMode`, `topK` or `temperature` (not available to web pages).
 */

import type { AIMessage } from "@/lib/ai/types";
import {
  LocalRuntimeError,
  type CapabilityReport,
  type LocalChunk,
  type LocalRuntimeErrorKind,
  type LocalProvider,
  type LocalStreamRequest,
  type LoadProgress,
} from "@/lib/private/core/local-provider";
import {
  BUILTIN_LANGUAGES,
  BUILTIN_MODEL,
  type BuiltinModelDescriptor,
  type BuiltinStatus,
  type BuiltinVendor,
} from "@/lib/private/core/provider-policy";

// ------------------------------------------------------------ minimal types
// Hand-written subset of the Prompt API, instead of @types/dom-chromium-ai.

export type LanguageModelAvailability = "unavailable" | "downloadable" | "downloading" | "available";

export interface LanguageModelExpected {
  type: "text";
  languages: string[];
}

export interface LanguageModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LanguageModelMonitorLike {
  addEventListener(type: "downloadprogress", listener: (event: { loaded: number }) => void): void;
}

export interface LanguageModelCreateOptions {
  expectedInputs: LanguageModelExpected[];
  expectedOutputs: LanguageModelExpected[];
  initialPrompts?: LanguageModelMessage[];
  monitor?: (monitor: LanguageModelMonitorLike) => void;
  signal?: AbortSignal;
}

export interface LanguageModelSessionLike {
  promptStreaming(input: string, options?: { signal?: AbortSignal }): AsyncIterable<string> | ReadableStream<string>;
  destroy(): void;
  readonly contextWindow?: number;
  readonly contextUsage?: number;
}

export interface LanguageModelStatic {
  availability(options: Omit<LanguageModelCreateOptions, "monitor" | "signal" | "initialPrompts">): Promise<LanguageModelAvailability>;
  create(options: LanguageModelCreateOptions): Promise<LanguageModelSessionLike>;
}

export interface BrowserLike {
  LanguageModel?: LanguageModelStatic;
  /** `userAgentData` exists only in secure contexts; /private is always one. */
  isSecureContext?: boolean;
  navigator?: {
    userAgent?: string;
    userAgentData?: { brands?: { brand: string; version?: string }[]; mobile?: boolean };
    brave?: unknown;
  };
}

/** Exactly the same expectations for availability() and create() (Chrome docs). */
export function expectations() {
  return {
    expectedInputs: [{ type: "text" as const, languages: [...BUILTIN_LANGUAGES] }],
    expectedOutputs: [{ type: "text" as const, languages: [...BUILTIN_LANGUAGES] }],
  };
}

function browserGlobal(): BrowserLike {
  return globalThis as unknown as BrowserLike;
}

// -------------------------------------------------------- browser identity

/** Only secure contexts with an explicit Chrome or Edge brand qualify. */
export function identifyBuiltinVendor(
  nav: BrowserLike["navigator"],
  secureContext?: boolean,
): BuiltinVendor | null {
  if (secureContext !== true || !nav || nav.brave !== undefined || nav.userAgentData?.mobile) return null;
  const brands = nav.userAgentData?.brands;
  if (!Array.isArray(brands)) return null;
  const ua = nav.userAgent ?? "";
  if (/Android|Mobile|iPhone|iPad|CriOS|EdgiOS|EdgA\//.test(ua)) return null;
  if (/\b(OPR|Opera|Vivaldi|YaBrowser|SamsungBrowser|Brave|Electron)\//.test(ua)) return null;
  const names = brands.map((brand) => brand.brand);
  if (names.includes("Microsoft Edge")) return "edge";
  if (names.includes("Google Chrome") && !/\bEdg\//.test(ua)) return "chrome";
  return null;
}

/** Model naming only. The verified Edge brand is required separately. */
function edgeMajorVersion(nav: BrowserLike["navigator"]): number {
  const version = nav?.userAgentData?.brands?.find(({ brand }) => brand === "Microsoft Edge")?.version;
  const brandMajor = /^(\d+)(?:\.\d+)*$/.exec(version ?? "")?.[1];
  const uaMajor = /\bEdg\/(\d+)(?:\.\d+)*(?=\s|$)/.exec(nav?.userAgent ?? "")?.[1];
  const major = Number(brandMajor ?? uaMajor);
  return Number.isSafeInteger(major) ? major : 0;
}

/** Local queries only: `availability()` never downloads anything. */
export async function detectBuiltin(win: BrowserLike = browserGlobal()): Promise<BuiltinStatus> {
  const api = win.LanguageModel;
  if (!api || typeof api.availability !== "function" || typeof api.create !== "function") {
    return { kind: "absent" };
  }
  const vendor = identifyBuiltinVendor(win.navigator, win.isSecureContext);
  if (!vendor) return { kind: "unverified" };
  const identity = vendor === "edge" && edgeMajorVersion(win.navigator) >= 158
    ? { vendor, model: "edge-aion" } as const
    : { vendor };
  let answer: LanguageModelAvailability;
  try {
    answer = await api.availability(expectations());
  } catch {
    return { kind: "unavailable", ...identity };
  }
  switch (answer) {
    case "available":
    case "downloadable":
    case "downloading":
      return { kind: answer, ...identity };
    default:
      return { kind: "unavailable", ...identity };
  }
}

// ------------------------------------------------------------------ errors

/** DOMException name → a content-free kind. */
export function builtinErrorKind(error: unknown): LocalRuntimeErrorKind {
  if (error instanceof LocalRuntimeError) return error.kind;
  const name = (error as { name?: unknown } | null)?.name;
  switch (name) {
    case "AbortError":
      return "cancelled";
    case "NotAllowedError":
      return "not_allowed";
    case "NetworkError":
      return "download_failed";
    case "NotSupportedError":
      return "unsupported";
    case "QuotaExceededError":
      return "context_exceeded";
    case "InvalidStateError":
      return "not_loaded";
    default:
      return "unknown";
  }
}

/** A per-turn session could not be created, so readiness needs a fresh probe. */
export class BuiltinSessionCreateError extends LocalRuntimeError {}

// ---------------------------------------------------------------- provider

async function* chunksOf(stream: AsyncIterable<string> | ReadableStream<string>): AsyncIterable<string> {
  if (Symbol.asyncIterator in stream) {
    yield* stream as AsyncIterable<string>;
    return;
  }
  const reader = (stream as ReadableStream<string>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Splits our budgeted message list into initial prompts and the new user turn. */
export function toPromptApiTurns(messages: AIMessage[]): {
  initial: LanguageModelMessage[];
  input: string;
} {
  const last = messages.at(-1);
  if (!last || last.role !== "user") throw new LocalRuntimeError("unknown");
  const initial: LanguageModelMessage[] = [];
  for (const m of messages.slice(0, -1)) {
    // Only one system prompt, and only first (the API rejects others).
    if (m.role === "system") {
      if (initial.length === 0) initial.push({ role: "system", content: m.content });
      continue;
    }
    initial.push({ role: m.role, content: m.content });
  }
  return { initial, input: last.content };
}

/**
 * Drops the oldest user/assistant exchange after the system prompt. `null`
 * when nothing but the system prompt is left to drop.
 */
export function dropOldestTurn(initial: LanguageModelMessage[]): LanguageModelMessage[] | null {
  const start = initial[0]?.role === "system" ? 1 : 0;
  if (initial.length <= start) return null;
  let end = start + 1;
  // Drop through the next assistant turn so the window opens on a user turn.
  while (end < initial.length && initial[end].role === "assistant") end++;
  return [...initial.slice(0, start), ...initial.slice(end)];
}

/**
 * `LocalProvider` over the browser's built-in model. `load()` creates a base
 * session (which, when the model is "downloadable"/"downloading", makes the
 * browser download it and therefore needs a click). Each turn then runs in a
 * fresh session seeded with the budgeted history, so no hidden state carries
 * over between turns or threads.
 */
export class BuiltinPromptApiProvider implements LocalProvider<BuiltinModelDescriptor> {
  readonly id = "builtin-prompt-api" as const;
  private base: LanguageModelSessionLike | null = null;
  private loaded: BuiltinModelDescriptor | null = null;

  constructor(
    readonly vendor: BuiltinVendor,
    private readonly win: BrowserLike = browserGlobal(),
  ) {}

  private api(): LanguageModelStatic {
    const api = this.win.LanguageModel;
    if (!api || identifyBuiltinVendor(this.win.navigator, this.win.isSecureContext) !== this.vendor) {
      throw new LocalRuntimeError("unsupported");
    }
    return api;
  }

  /** The session's own context window, once loaded. */
  get contextWindowTokens(): number | null {
    const size = this.base?.contextWindow;
    return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null;
  }

  async capability(): Promise<CapabilityReport> {
    return {
      runtime: "builtin-prompt-api",
      hasWebGPU: false,
      hasAdapter: false,
      isFallbackAdapter: false,
      shaderF16: false,
      maxBufferSize: null,
      maxStorageBufferBindingSize: null,
      gpuVendor: null,
      deviceMemoryGB: null,
      freeStorageBytes: null,
      isSafari: false,
      isMobile: false,
    };
  }

  async isCached(): Promise<boolean> {
    try {
      return (await this.api().availability(expectations())) === "available";
    } catch {
      return false;
    }
  }

  /**
   * Must run inside a click handler when the model is not yet "available":
   * the browser then downloads it and reports progress (0..1).
   */
  async load(
    model: BuiltinModelDescriptor,
    onProgress: (progress: LoadProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new LocalRuntimeError("cancelled");
    const browser = BUILTIN_MODEL[this.vendor].browser;
    try {
      const session = await this.api().create({
        ...expectations(),
        monitor(m) {
          m.addEventListener("downloadprogress", (event) => {
            const fraction = typeof event.loaded === "number" ? Math.min(1, Math.max(0, event.loaded)) : 0;
            onProgress({ fraction, text: `${browser} is downloading its built-in model…` });
          });
        },
        signal,
      });
      if (signal?.aborted) {
        session.destroy();
        throw new LocalRuntimeError("cancelled");
      }
      this.base?.destroy();
      this.base = session;
      this.loaded = model;
    } catch (error) {
      if (signal?.aborted) throw new LocalRuntimeError("cancelled");
      throw new LocalRuntimeError(builtinErrorKind(error));
    }
  }

  /** The Prompt API exposes no tokenizer; the controller uses its conservative estimate. */
  async countTokens(): Promise<number[] | null> {
    return null;
  }

  async *stream(request: LocalStreamRequest): AsyncIterable<LocalChunk> {
    if (!this.loaded || !this.base) throw new LocalRuntimeError("not_loaded");
    const model = this.loaded.id;
    const { signal } = request;
    const { initial, input } = toPromptApiTurns(request.messages);
    let history = initial;

    // A turn that does not fit drops the oldest history and tries again
    // (QuotaExceededError). If the new message alone does not fit, say so.
    for (;;) {
      if (signal?.aborted) return;
      let session: LanguageModelSessionLike | null = null;
      let yielded = false;
      try {
        session = await this.api().create({ ...expectations(), initialPrompts: history, signal });
        for await (const text of chunksOf(session.promptStreaming(input, { signal }))) {
          if (signal?.aborted) return;
          if (!text) continue;
          yielded = true;
          yield { type: "text", text };
        }
        if (signal?.aborted) return;
        yield { type: "done", model, finishReason: "stop", tokens: { input: 0, output: 0 } };
        return;
      } catch (error) {
        if (signal?.aborted) return;
        const kind = builtinErrorKind(error);
        if (kind === "context_exceeded" && !yielded) {
          const shorter = dropOldestTurn(history);
          if (shorter) {
            history = shorter;
            continue;
          }
        }
        if (!session) throw new BuiltinSessionCreateError(kind);
        if (kind === "not_loaded") await this.unload();
        throw new LocalRuntimeError(kind);
      } finally {
        try {
          session?.destroy();
        } catch {
          // Already gone.
        }
      }
    }
  }

  async unload(): Promise<void> {
    try {
      this.base?.destroy();
    } catch {
      // Already gone.
    }
    this.base = null;
    this.loaded = null;
  }

  /** The browser owns its model; KORUM never deletes it. */
  async deleteCached(): Promise<void> {}

  dispose(): void {
    void this.unload();
  }
}
