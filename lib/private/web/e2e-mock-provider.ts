/**
 * END-TO-END TEST ONLY. A deterministic stand-in for the WebLLM engine so the
 * Playwright suite can drive the real `/private` UI on machines without a GPU.
 *
 * It is reachable only through `createLocalProvider()` when the build was made
 * with `KORUM_E2E_MOCK_PROVIDER=1` (see `next.config.ts`). In every other build
 * that branch is a compile-time constant `false`, so this module is never
 * bundled. Nothing at runtime (URL, query, storage, globals) can enable it.
 *
 * It makes no network request and spawns no worker. The reply is a fixed
 * Markdown answer that echoes the `KORUM-CANARY-…` token from the last user
 * message into every place a renderer could leak it: remote and same-origin
 * images, a data: image, raw `<img>` HTML, inline code and a link.
 */

import type {
  CapabilityReport,
  LocalChunk,
  LocalModelDescriptor,
  LocalProvider,
  LocalStreamRequest,
} from "@/lib/private/core/local-provider";
import { LocalRuntimeError } from "@/lib/private/core/local-provider";

import { isSafariUA } from "./browser";

/** Present in the bundle only when this module is; the e2e suite checks normal builds for it. */
export const E2E_MOCK_MARKER = "korum-e2e-mock-provider";

const CANARY_PATTERN = /KORUM-CANARY-[0-9A-Za-z-]+/;
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function e2eMockReply(lastUserText: string, turn: number): string {
  const canary = CANARY_PATTERN.exec(lastUserText)?.[0] ?? "KORUM-CANARY-none";
  return [
    `Mock answer ${turn} for ${canary}.`,
    "",
    `![remote](https://canary.test/img?c=${canary})`,
    "",
    `![same-origin](/canary-same-origin?c=${canary})`,
    "",
    `![inline](${TINY_PNG})`,
    "",
    `<img src="https://canary.test/raw?c=${canary}" alt="raw">`,
    "",
    `Inline HTML as code: \`<img src="https://canary.test/code?c=${canary}">\``,
    "",
    `[canary link](https://canary.test/link?c=${canary})`,
  ].join("\n");
}

export class E2EMockLocalProvider implements LocalProvider {
  readonly id = "webllm" as const;
  private loaded: LocalModelDescriptor | null = null;
  private turn = 0;

  async capability(): Promise<CapabilityReport> {
    return {
      runtime: "webllm",
      hasWebGPU: true,
      hasAdapter: true,
      isFallbackAdapter: false,
      shaderF16: true,
      maxBufferSize: 4 * 1024 ** 3,
      maxStorageBufferBindingSize: 2 * 1024 ** 3,
      gpuVendor: E2E_MOCK_MARKER,
      deviceMemoryGB: 8,
      freeStorageBytes: 100 * 1024 ** 3,
      isSafari: isSafariUA(globalThis.navigator?.userAgent ?? ""),
    };
  }

  async isCached(): Promise<boolean> {
    return true;
  }

  async load(model: LocalModelDescriptor, _onProgress: unknown, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new LocalRuntimeError("cancelled");
    this.loaded = model;
  }

  async countTokens(): Promise<number[] | null> {
    return null;
  }

  async *stream(request: LocalStreamRequest): AsyncIterable<LocalChunk> {
    if (!this.loaded) throw new LocalRuntimeError("not_loaded");
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const text = e2eMockReply(lastUser?.content ?? "", ++this.turn);
    // A few chunks so the UI goes through its streaming state.
    for (const part of text.match(/[\s\S]{1,48}/g) ?? []) {
      if (request.signal?.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield { type: "text", text: part };
    }
    yield {
      type: "done",
      model: this.loaded.id,
      finishReason: "stop",
      tokens: { input: 0, output: 0 },
    };
  }

  async unload(): Promise<void> {
    this.loaded = null;
  }

  async deleteCached(): Promise<void> {}

  dispose(): void {
    this.loaded = null;
  }
}
