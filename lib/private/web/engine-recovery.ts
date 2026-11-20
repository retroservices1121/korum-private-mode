/**
 * What to do after the model fails for capacity reasons (OOM, GPU device
 * lost, pipeline creation), whether during load or mid-generation.
 *
 *   1. record the failure for that tier (time + tier only, never content);
 *   2. re-run pickTier: auto steps down past a tier with a recent failure,
 *      and two failures in 7 days block a tier even for a manual choice;
 *   3. a cached lower tier loads straight away (no download involved); an
 *      uncached one needs the user's explicit download approval;
 *   4. no tier left → the unavailable state. Never a remote model.
 */

import type { CapabilityReport } from "@/lib/private/core/local-provider";
import type { ModelTier } from "@/lib/private/core/model-catalog";
import {
  pickTier,
  recordFailure,
  type FailureHistory,
  type TierChoice,
  type TierDecision,
  type UnavailableReason,
} from "@/lib/private/core/tier-policy";

type OkDecision = Extract<TierDecision, { status: "ok" }>;

export type RecoveryStep =
  | { action: "load"; decision: OkDecision }
  | { action: "approve_download"; decision: OkDecision }
  | { action: "unavailable"; reason: UnavailableReason };

export async function recoverFromCapacityFailure(input: {
  report: CapabilityReport;
  choice: TierChoice;
  failures: FailureHistory;
  failedTier: ModelTier;
  now: number;
  isCached: (decision: OkDecision) => Promise<boolean>;
}): Promise<{ failures: FailureHistory; next: RecoveryStep }> {
  const failures = recordFailure(input.failures, input.failedTier, input.now);
  const decision = pickTier(input.report, { choice: input.choice, failures, now: input.now });
  if (decision.status === "unavailable") {
    return { failures, next: { action: "unavailable", reason: decision.reason } };
  }
  const cached = await input.isCached(decision).catch(() => false);
  return {
    failures,
    next: cached ? { action: "load", decision } : { action: "approve_download", decision },
  };
}
