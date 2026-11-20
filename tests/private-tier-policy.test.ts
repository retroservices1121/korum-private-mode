import { describe, expect, it } from "vitest";

import type { CapabilityReport } from "@/lib/private/core/local-provider";
import {
  heuristicTier,
  isTierBlocked,
  pickTier,
  POLICY,
  recordFailure,
  clearFailures,
  type FailureHistory,
  type TierPrefs,
} from "@/lib/private/core/tier-policy";

const GB = 1e9;
const NOW = 1_800_000_000_000;

function report(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    runtime: "webllm",
    hasWebGPU: true,
    hasAdapter: true,
    isFallbackAdapter: false,
    shaderF16: true,
    maxBufferSize: 2 * 1024 ** 3,
    maxStorageBufferBindingSize: 2 * 1024 ** 3,
    gpuVendor: "nvidia",
    deviceMemoryGB: 8,
    freeStorageBytes: 50 * GB,
    isSafari: false,
    ...overrides,
  };
}

const prefs = (overrides: Partial<TierPrefs> = {}): TierPrefs => ({
  choice: "auto",
  failures: {},
  now: NOW,
  ...overrides,
});

describe("pickTier floor", () => {
  it.each([
    ["no navigator.gpu", { hasWebGPU: false }, "no_webgpu"],
    ["no adapter", { hasAdapter: false }, "no_adapter"],
    ["fallback adapter", { isFallbackAdapter: true }, "fallback_adapter"],
    ["storage below Lite + headroom", { freeStorageBytes: 0.5 * GB }, "insufficient_storage"],
  ] as const)("%s → unavailable", (_name, overrides, reason) => {
    expect(pickTier(report(overrides), prefs())).toEqual({ status: "unavailable", reason });
  });
});

describe("pickTier heuristic table", () => {
  it.each([
    ["discrete NVIDIA, f16, 8 GB, 50 GB free", {}, "L"],
    ["AMD", { gpuVendor: "amd" }, "L"],
    ["Apple Silicon (Chrome) with deviceMemory 8", { gpuVendor: "apple" }, "L"],
    ["Intel iGPU, 8 GB", { gpuVendor: "intel" }, "M"],
    ["no shader-f16 → never L", { shaderF16: false }, "M"],
    ["L storage short (9 GB)", { freeStorageBytes: 9 * GB }, "M"],
    ["maxBufferSize below 1 GiB", { maxBufferSize: 512 * 1024 ** 2 }, "M"],
    ["deviceMemory 4", { deviceMemoryGB: 4 }, "S"],
    ["deviceMemory 2 → Lite", { deviceMemoryGB: 2 }, "XS"],
    ["deviceMemory 0.5 → Lite", { deviceMemoryGB: 0.5 }, "XS"],
    ["M storage short (4 GB)", { freeStorageBytes: 4 * GB }, "S"],
    ["unknown storage blocks L only", { freeStorageBytes: null }, "M"],
    ["unknown deviceMemory, Apple + f16 (Safari) → M proposed", { deviceMemoryGB: null, gpuVendor: "apple" }, "M"],
    ["unknown deviceMemory, Apple without f16 → S", { deviceMemoryGB: null, gpuVendor: "apple", shaderF16: false }, "S"],
    ["unknown deviceMemory, NVIDIA (Firefox) → S", { deviceMemoryGB: null }, "S"],
    ["unknown deviceMemory and vendor → S", { deviceMemoryGB: null, gpuVendor: null }, "S"],
  ] as const)("%s → %s", (_name, overrides, tier) => {
    expect(heuristicTier(report(overrides))).toBe(tier);
    const decision = pickTier(report(overrides), prefs());
    expect(decision.status === "ok" && decision.tier).toBe(tier);
  });
});

describe("artifact variant: f16 vs f32", () => {
  it("uses q4f16_1 when shader-f16 is present", () => {
    const decision = pickTier(report({ gpuVendor: "intel" }), prefs());
    expect(decision.status === "ok" && decision.artifact.quantization).toBe("q4f16_1");
    expect(decision.status === "ok" && decision.artifact.modelId).toBe("Qwen3-4B-q4f16_1-MLC");
  });

  it("uses q4f32_1 without shader-f16", () => {
    const decision = pickTier(report({ shaderF16: false }), prefs());
    expect(decision.status === "ok" && decision.artifact.quantization).toBe("q4f32_1");
    expect(decision.status === "ok" && decision.artifact.requiresShaderF16).toBe(false);
  });

  it("a manual L on a non-f16 device gets the f32 build", () => {
    const decision = pickTier(report({ shaderF16: false }), prefs({ choice: "L" }));
    expect(decision.status === "ok" && decision.artifact.modelId).toBe("Qwen3-8B-q4f32_1-MLC");
  });
});

describe("explicit download and step-down", () => {
  it("L always requires an explicit download click", () => {
    const decision = pickTier(report(), prefs());
    expect(decision.status === "ok" && decision.requiresExplicitDownload).toBe(true);
  });

  it("M picked directly does not need a step-down prompt", () => {
    const decision = pickTier(report({ gpuVendor: "intel" }), prefs());
    expect(decision.status === "ok" && decision.requiresExplicitDownload).toBe(false);
  });

  it("one recent failure at L steps auto down to M, and asks before downloading", () => {
    const failures = recordFailure({}, "L", NOW - 1000);
    const decision = pickTier(report(), prefs({ failures }));
    expect(decision.status).toBe("ok");
    if (decision.status !== "ok") return;
    expect(decision.tier).toBe("M");
    expect(decision.steppedDown).toBe(true);
    expect(decision.requiresExplicitDownload).toBe(true);
    expect(decision.selectable).toContain("L"); // one failure does not block
  });

  it("two failures in 7 days block a tier, even for a manual choice", () => {
    let failures: FailureHistory = recordFailure({}, "L", NOW - 2000);
    failures = recordFailure(failures, "L", NOW - 1000);
    expect(isTierBlocked(failures, "L", NOW)).toBe(true);
    const decision = pickTier(report(), prefs({ choice: "L", failures }));
    expect(decision.status === "ok" && decision.tier).toBe("M");
    expect(decision.status === "ok" && decision.selectable).not.toContain("L");
  });

  it("failures older than the window expire", () => {
    let failures: FailureHistory = recordFailure({}, "L", NOW - POLICY.failureWindowMs - 10);
    failures = recordFailure(failures, "L", NOW - POLICY.failureWindowMs - 5);
    expect(isTierBlocked(failures, "L", NOW)).toBe(false);
    expect(pickTier(report(), prefs({ failures })).status === "ok").toBe(true);
    const decision = pickTier(report(), prefs({ failures }));
    expect(decision.status === "ok" && decision.tier).toBe("L");
  });

  it("every tier blocked → unavailable, never a remote model", () => {
    let failures: FailureHistory = {};
    for (const tier of ["XS", "S", "M", "L"] as const) {
      failures = recordFailure(recordFailure(failures, tier, NOW - 2), tier, NOW - 1);
    }
    expect(pickTier(report(), prefs({ failures }))).toEqual({
      status: "unavailable",
      reason: "all_tiers_blocked",
    });
  });

  it("a failure at S steps down to Lite (XS)", () => {
    const failures = recordFailure({}, "S", NOW - 1);
    const decision = pickTier(report({ deviceMemoryGB: 4 }), prefs({ failures }));
    expect(decision.status === "ok" && decision.tier).toBe("XS");
    expect(decision.status === "ok" && decision.steppedDown).toBe(true);
    expect(decision.status === "ok" && decision.requiresExplicitDownload).toBe(true);
  });

  it("a failure at Lite under auto with no lower tier → unavailable", () => {
    const failures = recordFailure({}, "XS", NOW - 1);
    const decision = pickTier(report({ deviceMemoryGB: 2 }), prefs({ failures }));
    expect(decision).toEqual({ status: "unavailable", reason: "all_tiers_blocked" });
  });

  it("full step-down chain under auto: L → M → S → XS → unavailable", () => {
    let failures: FailureHistory = {};
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const decision = pickTier(report(), prefs({ failures }));
      if (decision.status === "unavailable") {
        seen.push("unavailable");
        break;
      }
      seen.push(decision.tier);
      failures = recordFailure(failures, decision.tier, NOW - 10 + i);
    }
    expect(seen).toEqual(["L", "M", "S", "XS", "unavailable"]);
  });

  it("storage that fits Lite but not Light gives Lite", () => {
    const decision = pickTier(report({ deviceMemoryGB: 4, freeStorageBytes: 1.6 * GB }), prefs());
    expect(decision.status === "ok" && decision.tier).toBe("XS");
  });

  it("Lite uses the Qwen3-1.7B builds (f16 and f32)", () => {
    const f16 = pickTier(report({ deviceMemoryGB: 2 }), prefs());
    expect(f16.status === "ok" && f16.artifact.modelId).toBe("Qwen3-1.7B-q4f16_1-MLC");
    const f32 = pickTier(report({ deviceMemoryGB: 2, shaderF16: false }), prefs());
    expect(f32.status === "ok" && f32.artifact.modelId).toBe("Qwen3-1.7B-q4f32_1-MLC");
  });

  it("clearFailures is the manual retry", () => {
    let failures: FailureHistory = recordFailure(recordFailure({}, "L", NOW - 2), "L", NOW - 1);
    failures = clearFailures(failures, "L");
    expect(isTierBlocked(failures, "L", NOW)).toBe(false);
  });
});
