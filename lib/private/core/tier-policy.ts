/**
 * Auto tier selection for WebLLM. The policy is a pure function with table tests.
 *
 * Tiers size the downloadable model catalog (`model-catalog.ts`). It depends
 * only on a `CapabilityReport` and the catalog, never on a runtime, so a
 * provider with a fixed built-in model can skip it without touching it.
 *
 * The thresholds are PROVISIONAL heuristics. WebGPU does not expose VRAM and
 * `deviceMemory` is Chromium-only and capped at 8, so the policy proposes a
 * tier and the load proves it; a failed load steps down (see
 * `recordFailure`). Calibrate them against real hardware before changing.
 */

import type { CapabilityReport } from "./local-provider";
import {
  artifactFor,
  modelForTier,
  TIER_ORDER,
  type CatalogModel,
  type ModelTier,
  type WebLLMArtifact,
} from "./model-catalog";

const GiB = 1024 ** 3;
const GB = 1_000_000_000;

export const POLICY = {
  /** Download headroom on top of the artifact size. */
  storageHeadroom: 1.2,
  lMinFreeStorageBytes: 10 * GB,
  mMinFreeStorageBytes: 5 * GB,
  lMinMaxBufferSize: 1 * GiB,
  lVendors: ["nvidia", "amd", "apple"] as readonly string[],
  minDeviceMemoryGB: 8,
  /** Below this known deviceMemory, Mini (0.6B) is proposed. */
  miniBelowDeviceMemoryGB: 4,
  /** Two failures inside this window block a tier. */
  failureWindowMs: 7 * 24 * 60 * 60 * 1000,
  failuresToBlock: 2,
} as const;

/**
 * Load failures per tier, as epoch-ms timestamps. Kind only, never content.
 * Stored in localStorage.
 */
export type FailureHistory = Partial<Record<ModelTier, number[]>>;

export type TierChoice = "auto" | ModelTier;

export interface TierPrefs {
  choice: TierChoice;
  failures: FailureHistory;
  now: number;
}

export type UnavailableReason =
  | "no_webgpu"
  | "no_adapter"
  | "fallback_adapter"
  | "insufficient_storage"
  | "all_tiers_blocked";

export type TierDecision =
  | { status: "unavailable"; reason: UnavailableReason }
  | {
      status: "ok";
      tier: ModelTier;
      model: CatalogModel;
      artifact: WebLLMArtifact;
      /** What auto-pick recommends on this device. */
      recommended: ModelTier;
      /** Tiers the user may pick by hand (above the floor and not blocked). */
      selectable: ModelTier[];
      /** The chosen tier is below what was asked for because of failures. */
      steppedDown: boolean;
      /**
       * Never download this tier without a click (L always, and any step-down).
       * The web shell requires a click for every first download anyway.
       */
      requiresExplicitDownload: boolean;
    };

function recentFailures(failures: FailureHistory, tier: ModelTier, now: number): number {
  return (failures[tier] ?? []).filter((at) => now - at < POLICY.failureWindowMs).length;
}

export function isTierBlocked(failures: FailureHistory, tier: ModelTier, now: number): boolean {
  return recentFailures(failures, tier, now) >= POLICY.failuresToBlock;
}

/** Records a load failure; returns a new history with stale entries pruned. */
export function recordFailure(
  failures: FailureHistory,
  tier: ModelTier,
  now: number,
): FailureHistory {
  const kept = (failures[tier] ?? []).filter((at) => now - at < POLICY.failureWindowMs);
  return { ...failures, [tier]: [...kept, now] };
}

/** The user's explicit "retry this tier" from settings. */
export function clearFailures(failures: FailureHistory, tier: ModelTier): FailureHistory {
  const next = { ...failures };
  delete next[tier];
  return next;
}

export function tierBelow(tier: ModelTier): ModelTier | null {
  const index = TIER_ORDER.indexOf(tier);
  return index > 0 ? TIER_ORDER[index - 1] : null;
}

function fitsStorage(report: CapabilityReport, tier: ModelTier): boolean {
  if (report.freeStorageBytes === null) return true; // proven (or not) by the download
  const artifact = artifactFor(modelForTier(tier), report.shaderF16);
  return report.freeStorageBytes >= artifact.downloadBytes * POLICY.storageHeadroom;
}

function floorFailure(report: CapabilityReport): UnavailableReason | null {
  if (!report.hasWebGPU) return "no_webgpu";
  if (!report.hasAdapter) return "no_adapter";
  if (report.isFallbackAdapter) return "fallback_adapter";
  if (!fitsStorage(report, TIER_ORDER[0])) return "insufficient_storage";
  return null;
}

/** The heuristic proposal before failures are considered. */
export function heuristicTier(report: CapabilityReport): ModelTier {
  const memory = report.deviceMemoryGB;
  const free = report.freeStorageBytes;
  const vendor = report.gpuVendor?.toLowerCase() ?? null;

  // Phones (deviceMemory is capped at 8 and absent on iOS, so it cannot tell
  // a phone from a laptop) and known low-memory devices get Mini. Lite stays
  // a manual upgrade and a step-down target.
  if (report.isMobile) return "XXS";
  if (memory !== null && memory < POLICY.miniBelowDeviceMemoryGB) return "XXS";

  const lFits =
    report.shaderF16 &&
    memory !== null &&
    memory >= POLICY.minDeviceMemoryGB &&
    report.maxBufferSize !== null &&
    report.maxBufferSize >= POLICY.lMinMaxBufferSize &&
    vendor !== null &&
    POLICY.lVendors.includes(vendor) &&
    free !== null &&
    free >= POLICY.lMinFreeStorageBytes;
  if (lFits) return "L";

  const mStorage = free === null || free >= POLICY.mMinFreeStorageBytes;
  if (memory !== null) {
    if (memory >= POLICY.minDeviceMemoryGB && mStorage) return "M";
    return "S";
  }
  // Unknown deviceMemory (Safari/Firefox): proposed, not assumed.
  if (vendor === "apple" && report.shaderF16 && mStorage) return "M";
  return "S";
}

export function pickTier(report: CapabilityReport, prefs: TierPrefs): TierDecision {
  const floor = floorFailure(report);
  if (floor) return { status: "unavailable", reason: floor };

  const selectable = TIER_ORDER.filter(
    (tier) => fitsStorage(report, tier) && !isTierBlocked(prefs.failures, tier, prefs.now),
  );
  if (selectable.length === 0) return { status: "unavailable", reason: "all_tiers_blocked" };

  const recommended = heuristicTier(report);
  const wanted: ModelTier = prefs.choice === "auto" ? recommended : prefs.choice;

  // Auto steps down past any tier with a recent failure; a manual choice
  // only steps down past a blocked tier.
  const skip = (tier: ModelTier) =>
    !selectable.includes(tier) ||
    (prefs.choice === "auto" && recentFailures(prefs.failures, tier, prefs.now) > 0);

  let tier: ModelTier | null = wanted;
  while (tier && skip(tier)) tier = tierBelow(tier);
  if (!tier) return { status: "unavailable", reason: "all_tiers_blocked" };

  const model = modelForTier(tier);
  const steppedDown = tier !== wanted;
  return {
    status: "ok",
    tier,
    model,
    artifact: artifactFor(model, report.shaderF16),
    recommended,
    selectable,
    steppedDown,
    requiresExplicitDownload: tier === "L" || steppedDown,
  };
}
