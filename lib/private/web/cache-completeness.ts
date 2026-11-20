/**
 * Is a model REALLY on this device?
 *
 * WebLLM 0.2.88's `hasModelInCache()` only checks the weight shards (tensor
 * cache in "webllm/model"). The chat config lives in "webllm/config", the
 * kernel .wasm in "webllm/wasm" and the tokenizer next to the weights. If any
 * of them was evicted, loading would silently download it. So a model counts
 * as cached only when every artifact the engine reads is present; otherwise
 * the UI shows the download approval screen.
 *
 * This helper checks presence only. artifact-integrity.ts verifies engine-read bytes against the SHA-256 pins.
 */

import type { WebLLMArtifact } from "@/lib/private/core/model-catalog";

export interface CacheLike {
  match(request: string): Promise<unknown>;
}
export interface CacheStorageLike {
  has(name: string): Promise<boolean>;
  open(name: string): Promise<CacheLike>;
}

export const WEBLLM_CACHES = {
  weights: "webllm/model",
  config: "webllm/config",
  wasm: "webllm/wasm",
} as const;

/** The `ModelRecord.model` URL the worker gives WebLLM for this artifact. */
export function recordModelUrl(artifact: WebLLMArtifact): string {
  const base = artifact.pinnedBaseUrl ?? artifact.modelUrl;
  return artifact.revision ? `${base}/resolve/${artifact.revision}/` : base;
}

/** Same normalisation as WebLLM's `cleanModelUrl`: `/resolve/main/` when no branch is given. */
export function resolvedModelBase(artifact: WebLLMArtifact): string {
  let url = recordModelUrl(artifact);
  url += url.endsWith("/") ? "" : "/";
  if (!/.+\/resolve\/.+\//.test(url)) url += "resolve/main/";
  return new URL(url).href;
}

export type MissingArtifact = "weights" | "config" | "tokenizer" | "wasm";

export async function missingArtifacts(
  artifact: WebLLMArtifact,
  weightsCached: boolean,
  storage: CacheStorageLike,
): Promise<MissingArtifact[]> {
  const base = resolvedModelBase(artifact);
  const present = async (cacheName: string, url: string) => {
    try {
      if (!(await storage.has(cacheName))) return false;
      return (await (await storage.open(cacheName)).match(url)) !== undefined;
    } catch {
      return false;
    }
  };

  const missing: MissingArtifact[] = [];
  if (!weightsCached) missing.push("weights");
  if (!(await present(WEBLLM_CACHES.config, new URL("mlc-chat-config.json", base).href))) {
    missing.push("config");
  }
  const tokenizer =
    (await present(WEBLLM_CACHES.weights, new URL("tokenizer.json", base).href)) ||
    (await present(WEBLLM_CACHES.weights, new URL("tokenizer.model", base).href));
  if (!tokenizer) missing.push("tokenizer");
  if (!(await present(WEBLLM_CACHES.wasm, artifact.modelLibUrl))) missing.push("wasm");
  return missing;
}
