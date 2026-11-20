/**
 * `WebLLMLocalProvider implements LocalProvider`. Main-thread side
 * of `webllm-worker.ts`. It never imports WebLLM itself, so the multi-MB
 * runtime only loads inside the worker.
 */

import {
  LocalRuntimeError,
  type CapabilityReport,
  type LocalChunk,
  type LocalModelDescriptor,
  type LocalProvider,
  type LocalStreamRequest,
  type LoadProgress,
} from "@/lib/private/core/local-provider";
import { findCatalogModel } from "@/lib/private/core/model-catalog";
import { engineArtifacts } from "@/lib/private/core/model-pins";
import { MODELS_BASE_URL } from "@/lib/private/core/models-host";

import { probeCapability } from "./capability-probe";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;
type RequestBody = Distribute<WorkerRequest>;

export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: { preventDefault?: () => void }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  terminate(): void;
}

export function createWebLLMWorker(): WorkerLike {
  return new Worker(new URL("./webllm-worker.ts", import.meta.url), {
    type: "module",
    name: "korum-private-engine",
  }) as unknown as WorkerLike;
}

type Listener = (message: WorkerResponse) => void;

export class WebLLMLocalProvider implements LocalProvider {
  readonly id = "webllm" as const;
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private listeners = new Map<number, Listener>();
  private loaded: LocalModelDescriptor | null = null;
  onDeviceLost: (() => void) | null = null;
  /** Called after the worker crashed or failed to start; the next call starts a fresh one. */
  onWorkerFailure: (() => void) | null = null;

  constructor(private readonly createWorker: () => WorkerLike = createWebLLMWorker) {}

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "device_lost") {
        this.loaded = null;
        this.onDeviceLost?.();
        return;
      }
      this.listeners.get(message.id)?.(message);
    };
    // A module-load failure or crash. The event can carry
    // runtime text, so only a content-free kind leaves this handler.
    worker.onerror = (event) => {
      event?.preventDefault?.();
      this.failWorker(worker);
    };
    worker.onmessageerror = () => this.failWorker(worker);
    this.worker = worker;
    return worker;
  }

  /** Settles every pending operation, drops the worker and the loaded state. */
  private failWorker(worker: WorkerLike) {
    if (this.worker !== worker) return;
    const pending = [...this.listeners.values()];
    this.listeners.clear();
    this.worker = null;
    this.loaded = null;
    try {
      worker.terminate();
    } catch {
      // Already gone.
    }
    for (const listener of pending) listener({ id: 0, type: "error", kind: "worker_failed" });
    this.onWorkerFailure?.();
  }

  /** Explicit retry after a worker failure: the next operation spawns a new worker. */
  retry(): void {
    this.dispose();
  }

  private send(body: RequestBody, listener: Listener): number {
    const id = this.nextId++;
    this.listeners.set(id, listener);
    this.ensureWorker().postMessage({ ...body, id } as WorkerRequest);
    return id;
  }

  private call<T>(body: RequestBody, onProgress?: (p: LoadProgress) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.send(body, (message) => {
        if (message.type === "progress") {
          onProgress?.({ fraction: message.fraction, text: message.text });
          return;
        }
        this.listeners.delete(id);
        if (message.type === "error") reject(new LocalRuntimeError(message.kind));
        else if (message.type === "result") resolve(message.value as T);
      });
    });
  }

  capability(): Promise<CapabilityReport> {
    return probeCapability();
  }

  async isCached(model: LocalModelDescriptor): Promise<boolean> {
    // Cache Storage is shared with the worker. Check presence without opening
    // empty caches or loading its bundle. The worker still verifies bytes on load.
    try {
      for (const pin of engineArtifacts(model.artifact.modelId, MODELS_BASE_URL)) {
        if (!await caches.match(pin.url, { cacheName: pin.cache })) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async load(
    model: LocalModelDescriptor,
    onProgress: (progress: LoadProgress) => void,
    signal?: AbortSignal,
    allowDownload = true,
  ): Promise<void> {
    if (signal?.aborted) throw new LocalRuntimeError("cancelled");
    const onAbort = () => void this.call({ type: "cancel_load" }).catch(() => undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.call(
        {
          type: "load",
          allowDownload,
          artifact: model.artifact,
          disableThinking: findCatalogModel(model.id)?.hybridThinking ?? true,
        },
        onProgress,
      );
      this.loaded = model;
    } catch (error) {
      this.loaded = null;
      if (signal?.aborted) throw new LocalRuntimeError("cancelled");
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async countTokens(texts: string[]): Promise<number[] | null> {
    if (!this.loaded) return null;
    return this.call<number[] | null>({ type: "count_tokens", texts }).catch(() => null);
  }

  async *stream(request: LocalStreamRequest): AsyncIterable<LocalChunk> {
    if (!this.loaded) throw new LocalRuntimeError("not_loaded");
    const model = this.loaded.id;
    const queue: (LocalChunk | LocalRuntimeError)[] = [];
    let wake: (() => void) | null = null;
    let finished = false;

    const id = this.send(
      {
        type: "generate",
        messages: request.messages,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      },
      (message) => {
        if (message.type === "delta") queue.push({ type: "text", text: message.text });
        else if (message.type === "generated") {
          queue.push({
            type: "done",
            model,
            finishReason: message.finishReason,
            tokens: message.tokens,
          });
          finished = true;
        } else if (message.type === "error") {
          queue.push(new LocalRuntimeError(message.kind));
          finished = true;
        }
        wake?.();
      },
    );

    const onAbort = () => void this.call({ type: "interrupt" }).catch(() => undefined);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        if (queue.length === 0) {
          if (finished) return;
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
          continue;
        }
        const item = queue.shift()!;
        if (item instanceof LocalRuntimeError) throw item;
        yield item;
        if (item.type === "done") return;
      }
    } finally {
      this.listeners.delete(id);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  async unload(): Promise<void> {
    if (!this.worker) return;
    await this.call({ type: "unload" }).catch(() => undefined);
    this.loaded = null;
  }

  async deleteCached(model: LocalModelDescriptor): Promise<void> {
    await this.call({ type: "delete_cache", artifact: model.artifact });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.loaded = null;
    this.listeners.clear();
  }
}
