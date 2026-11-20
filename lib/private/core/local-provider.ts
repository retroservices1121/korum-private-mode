/**
 * Private Mode portable core: the on-device inference contract.
 *
 * `LocalProvider` is the one seam between the app and an inference runtime.
 * It has no cost, no end-user id, no web search and no citations: local
 * inference is free, unattributed and offline. Every runtime (today WebLLM;
 * later e.g. a browser built-in model) implements this interface and is
 * chosen in `lib/private/web/provider-factory.ts`. Model selection currently
 * uses the WebLLM catalog.
 *
 * PORTABLE CORE RULE: nothing in `lib/private/core/` may touch React,
 * Next, the DOM, `fetch`, storage globals or Node built-ins. Enforced by
 * `tests/private-boundary.test.ts`.
 */

import type { AIFinishReason, AIMessage } from "@/lib/ai/types";

import type { ModelTier, WebLLMArtifact } from "./model-catalog";

/**
 * Identifies an inference runtime. Only "webllm" is implemented in this repo;
 * a new runtime adds its id here and registers a factory in
 * `lib/private/web/provider-factory.ts`.
 */
export type LocalRuntimeId = "webllm";

/**
 * Everything `pickTier` needs to know about a device, gathered by the shell's
 * probe. Numbers the platform does not expose stay `null` rather than being
 * guessed: an unknown value is never evidence that a tier fits.
 */
export interface CapabilityReport {
  runtime: LocalRuntimeId;
  /** `navigator.gpu` exists. */
  hasWebGPU: boolean;
  /** `requestAdapter()` returned an adapter. */
  hasAdapter: boolean;
  /** The adapter is a software/CPU fallback (`isFallbackAdapter`). */
  isFallbackAdapter: boolean;
  /** `adapter.features.has("shader-f16")`. */
  shaderF16: boolean;
  /** `adapter.limits.maxBufferSize`, bytes. */
  maxBufferSize: number | null;
  /** `adapter.limits.maxStorageBufferBindingSize`, bytes. */
  maxStorageBufferBindingSize: number | null;
  /** Lower-cased `adapter.info.vendor`, e.g. "nvidia", "apple", "intel". */
  gpuVendor: string | null;
  /** `navigator.deviceMemory` in GB (Chromium only, capped at 8). */
  deviceMemoryGB: number | null;
  /** `quota - usage` from `navigator.storage.estimate()`, bytes. */
  freeStorageBytes: number | null;
  /** The browser runs as Safari (affects the ITP storage notice only). */
  isSafari: boolean;
}

export interface LocalModelDescriptor {
  /** Logical catalog id, e.g. `local/qwen3-4b`. */
  id: string;
  tier: ModelTier;
  displayName: string;
  contextWindowTokens: number;
  /** The concrete runtime build to load. */
  artifact: WebLLMArtifact;
}

export interface LoadProgress {
  /** 0..1, as reported by the runtime. */
  fraction: number;
  /** Human-readable runtime status, never model output. */
  text: string;
}

export interface LocalStreamRequest {
  messages: AIMessage[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type LocalChunk =
  | { type: "text"; text: string }
  | {
      type: "done";
      model: string;
      finishReason: AIFinishReason;
      tokens: { input: number; output: number };
    };

/**
 * What went wrong, as a closed set of kinds. Never carries model output or the
 * user's text, so a kind can be stored (failure memory) or shown safely.
 */
export type LocalRuntimeErrorKind =
  | "unsupported"
  | "out_of_memory"
  | "device_lost"
  | "pipeline_failed"
  | "download_failed"
  | "quota_exceeded"
  | "integrity_failed"
  | "context_exceeded"
  | "cancelled"
  | "not_loaded"
  /** The engine worker crashed or failed to start; a retry spawns a new one. */
  | "worker_failed"
  | "unknown";

export class LocalRuntimeError extends Error {
  readonly kind: LocalRuntimeErrorKind;

  constructor(kind: LocalRuntimeErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "LocalRuntimeError";
    this.kind = kind;
  }

  /** A failure that says this tier does not fit this device. */
  get isLoadCapacityFailure(): boolean {
    return (
      this.kind === "out_of_memory" ||
      this.kind === "device_lost" ||
      this.kind === "pipeline_failed"
    );
  }
}

export interface LocalProvider {
  readonly id: LocalRuntimeId;
  capability(): Promise<CapabilityReport>;
  /** Whether the model's artifacts are already in local storage. */
  isCached(model: LocalModelDescriptor): Promise<boolean>;
  load(
    model: LocalModelDescriptor,
    onProgress: (progress: LoadProgress) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Token count for `text` under the loaded model's own tokenizer, or `null`
   * when the runtime cannot tell (the caller then uses a conservative
   * estimate).
   */
  countTokens(texts: string[]): Promise<number[] | null>;
  stream(request: LocalStreamRequest): AsyncIterable<LocalChunk>;
  unload(): Promise<void>;
  /** Remove the model's cached artifacts. */
  deleteCached(model: LocalModelDescriptor): Promise<void>;
}
