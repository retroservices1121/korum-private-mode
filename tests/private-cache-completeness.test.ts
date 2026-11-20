import { describe, expect, it } from "vitest";

import { artifactFor, modelForTier } from "@/lib/private/core/model-catalog";
import {
  missingArtifacts,
  resolvedModelBase,
  WEBLLM_CACHES,
  type CacheStorageLike,
} from "@/lib/private/web/cache-completeness";

/** A partly evicted model is NOT cached, so the user must approve a download. */

const artifact = artifactFor(modelForTier("M"), true);
const base = `${artifact.pinnedBaseUrl}/resolve/${artifact.revision}/`;

function storage(entries: Record<string, string[]>): CacheStorageLike {
  return {
    has: async (name) => name in entries,
    open: async (name) => ({
      match: async (url) => ((entries[name] ?? []).includes(url) ? new Response("x") : undefined),
    }),
  };
}

const FULL = {
  [WEBLLM_CACHES.weights]: [`${base}tokenizer.json`],
  [WEBLLM_CACHES.config]: [`${base}mlc-chat-config.json`],
  [WEBLLM_CACHES.wasm]: [artifact.modelLibUrl],
};

describe("model cache completeness", () => {
  it("resolves the same base URL WebLLM caches under", () => {
    expect(resolvedModelBase(artifact)).toBe(base);
  });

  it("complete only when weights, config, tokenizer and wasm are all present", async () => {
    expect(await missingArtifacts(artifact, true, storage(FULL))).toEqual([]);
  });

  it("accepts tokenizer.model as the tokenizer", async () => {
    const entries = { ...FULL, [WEBLLM_CACHES.weights]: [`${base}tokenizer.model`] };
    expect(await missingArtifacts(artifact, true, storage(entries))).toEqual([]);
  });

  it.each([
    ["weight shards", true, "weights"],
    ["mlc-chat-config.json", false, "config"],
    ["tokenizer", false, "tokenizer"],
    ["kernel wasm", false, "wasm"],
  ] as const)("evicting only the %s makes the model not cached", async (_what, dropWeights, key) => {
    const entries: Record<string, string[]> = { ...FULL };
    if (key === "config") entries[WEBLLM_CACHES.config] = [];
    if (key === "tokenizer") entries[WEBLLM_CACHES.weights] = [];
    if (key === "wasm") delete entries[WEBLLM_CACHES.wasm];
    expect(await missingArtifacts(artifact, !dropWeights, storage(entries))).toEqual([key]);
  });

  it("an empty or throwing cache storage means nothing is cached", async () => {
    expect(await missingArtifacts(artifact, false, storage({}))).toEqual([
      "weights",
      "config",
      "tokenizer",
      "wasm",
    ]);
    const broken: CacheStorageLike = {
      has: async () => {
        throw new Error("SecurityError");
      },
      open: async () => {
        throw new Error("SecurityError");
      },
    };
    expect(await missingArtifacts(artifact, true, broken)).toEqual(["config", "tokenizer", "wasm"]);
  });

  it("the worker reports cached only when nothing is missing", async () => {
    const src = (await import("node:fs")).readFileSync("lib/private/web/webllm-worker.ts", "utf8");
    expect(src).toMatch(/access.complete\(engineArtifacts/);
    expect(src).toMatch(/value: complete/);
  });
});
