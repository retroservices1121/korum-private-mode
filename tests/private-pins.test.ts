import { describe, expect, it } from "vitest";

import { findCatalogModel, MODEL_CATALOG } from "@/lib/private/core/model-catalog";
import { MODEL_PINS, pinnedLib, pinnedModel } from "@/lib/private/core/model-pins";

const LIB_COMMIT = "146ed9cd4b4062e967b017fd2291f7106b50599f";

/** R2 key layout, written out here so the test does not trust the pins file's own templates. */
const modelKey = (modelId: string, revision: string, path: string) =>
  `v1/models/${modelId}/resolve/${revision}/${path}`;
const libKey = (commit: string, file: string) => `v1/libs/${commit}/${file}`;
const libFileFor = (modelId: string) => `${modelId.replace(/-MLC$/, "")}_cs1k-webgpu.wasm`;

/** Pins for the eight models that existed before Mini. They must never change. */
const PREVIOUS = [
  ["Qwen3-8B-q4f16_1-MLC", "b3d55c289eae58f77095f5b68c895eeea358ee09", 4623994970, 6875765],
  ["Qwen3-8B-q4f32_1-MLC", "34026572351006ba1865d11319309b151d9ccf16", 4624183016, 6735189],
  ["Qwen3-4B-q4f16_1-MLC", "a5c9fab855e3ccbdfed2e7e69683d75f30332161", 2279164186, 6874869],
  ["Qwen3-4B-q4f32_1-MLC", "b7e4eb1ba80728187fb5df44055cc1a7c32310e0", 2279342605, 6732810],
  ["Llama-3.2-3B-Instruct-q4f16_1-MLC", "1e80abf71e3d17cd564e2d2b63caa15cb226018e", 1816808085, 6952125],
  ["Llama-3.2-3B-Instruct-q4f32_1-MLC", "6083cfdaaf08d2dd4872d7f5b87fb0242aa7d75c", 1816927936, 6752452],
  ["Qwen3-1.7B-q4f16_1-MLC", "80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc", 984153296, 6589747],
  ["Qwen3-1.7B-q4f32_1-MLC", "bddd4d584cabe19113f7e4ff46fd9e73b4d3dc89", 984286052, 6467624],
] as const;

const MINI = [
  ["Qwen3-0.6B-q4f16_1-MLC", "8c14ce481d4c692769976ad52afea453a102df19", 351514161, 6561594, 16],
  ["Qwen3-0.6B-q4f32_1-MLC", "9b4f0b05b08c692ea86fe151ea878406ad22f428", 351641973, 6440711, 17],
] as const;

describe("model pins", () => {
  it("keeps the previous eight models' pins unchanged, in order", () => {
    expect(MODEL_PINS.models.slice(0, 8).map((m) => [m.modelId, m.revision, m.bytes])).toEqual(
      PREVIOUS.map(([id, rev, bytes]) => [id, rev, bytes]),
    );
    expect(MODEL_PINS.libs.slice(0, 8).map((l) => [l.modelId, l.commit, l.bytes])).toEqual(
      PREVIOUS.map(([id, , , lib]) => [id, LIB_COMMIT, lib]),
    );
  });

  it("uses one lib commit for every model", () => {
    expect(new Set(MODEL_PINS.libs.map((l) => l.commit))).toEqual(new Set([LIB_COMMIT]));
  });

  it.each(MINI)("pins %s to an exact revision with hashed files and R2 keys", (modelId, revision, bytes, libBytes, fileCount) => {
    const model = pinnedModel(modelId);
    expect(model.revision).toBe(revision);
    expect(model.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(model.hfRepo).toBe(`mlc-ai/${modelId}`);
    expect(model.keyPrefix).toBe(modelKey(modelId, revision, ""));
    expect(model.bytes).toBe(bytes);
    expect(model.files).toHaveLength(fileCount);
    expect(model.files.reduce((n, f) => n + f.bytes, 0)).toBe(bytes);
    for (const file of model.files) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.bytes).toBeGreaterThan(0);
    }
    expect(model.files.map((f) => f.path)).toContain("mlc-chat-config.json");

    const lib = pinnedLib(modelId);
    expect(lib.commit).toBe(LIB_COMMIT);
    expect(lib.file).toBe(libFileFor(modelId));
    expect(lib.key).toBe(libKey(LIB_COMMIT, lib.file));
    expect(lib.bytes).toBe(libBytes);
    expect(lib.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("Mini artifacts in the catalog point only at R2, never upstream", () => {
    const mini = findCatalogModel("local/qwen3-0.6b")!;
    for (const artifact of [mini.webllm.f16, mini.webllm.f32]) {
      const json = JSON.stringify(artifact);
      expect(json).not.toMatch(/huggingface\.co|githubusercontent|github\.com/);
      expect(artifact.modelLibUrl).toContain(`/v1/libs/${LIB_COMMIT}/`);
    }
    expect(mini.webllm.f16.downloadBytes + mini.webllm.f32.downloadBytes).toBe(716_158_439);
  });

  it("Mini is wired into the catalog as XXS with hybrid thinking (kept off)", () => {
    const mini = findCatalogModel("local/qwen3-0.6b")!;
    expect(mini.tier).toBe("XXS");
    expect(mini.hybridThinking).toBe(true);
    expect([mini.webllm.f16.modelId, mini.webllm.f32.modelId]).toEqual(MINI.map(([id]) => id));
  });

  it("every catalog artifact is pinned, and nothing else is", () => {
    const ids = MODEL_CATALOG.flatMap((m) => [m.webllm.f16.modelId, m.webllm.f32.modelId]);
    expect(MODEL_PINS.models.map((m) => m.modelId).sort()).toEqual([...ids].sort());
    expect(MODEL_PINS.libs.map((l) => l.modelId).sort()).toEqual([...ids].sort());
  });
});
