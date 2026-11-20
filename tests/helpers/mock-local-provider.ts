import {
  LocalRuntimeError,
  type CapabilityReport,
  type LocalChunk,
  type LocalModelDescriptor,
  type LocalProvider,
  type LocalStreamRequest,
} from "@/lib/private/core/local-provider";
import { artifactFor, modelForTier } from "@/lib/private/core/model-catalog";

export const CAPABLE_REPORT: CapabilityReport = {
  runtime: "webllm",
  hasWebGPU: true,
  hasAdapter: true,
  isFallbackAdapter: false,
  shaderF16: true,
  maxBufferSize: 2 * 1024 ** 3,
  maxStorageBufferBindingSize: 2 * 1024 ** 3,
  gpuVendor: "nvidia",
  deviceMemoryGB: 8,
  freeStorageBytes: 50e9,
  isSafari: false,
};

export function descriptor(tier: "XS" | "S" | "M" | "L" = "M"): LocalModelDescriptor {
  const model = modelForTier(tier);
  const artifact = artifactFor(model, true);
  return {
    id: model.id,
    tier,
    displayName: model.displayName,
    contextWindowTokens: artifact.contextWindowTokens,
    artifact,
  };
}

/**
 * Scripted on-device model. Each `stream()` call takes the next reply; a
 * reply chunk of `"<wait>"` blocks until the request is aborted.
 */
export class MockLocalProvider implements LocalProvider {
  readonly id = "webllm" as const;
  replies: string[][] = [];
  failWith: LocalRuntimeError | null = null;
  requests: LocalStreamRequest[] = [];
  loaded: LocalModelDescriptor | null = null;

  async capability() {
    return CAPABLE_REPORT;
  }
  async isCached() {
    return true;
  }
  async load(model: LocalModelDescriptor) {
    this.loaded = model;
  }
  async countTokens(texts: string[]): Promise<number[] | null> {
    return texts.map((t) => Math.ceil(t.length / 4));
  }
  async *stream(request: LocalStreamRequest): AsyncIterable<LocalChunk> {
    this.requests.push(request);
    if (this.failWith) throw this.failWith;
    const reply = this.replies.shift() ?? ["ok"];
    for (const text of reply) {
      if (text === "<wait>") {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) return resolve();
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        break;
      }
      yield { type: "text", text };
    }
    yield { type: "done", model: "mock", finishReason: "stop", tokens: { input: 1, output: 1 } };
  }
  async unload() {
    this.loaded = null;
  }
  async deleteCached() {}
}
