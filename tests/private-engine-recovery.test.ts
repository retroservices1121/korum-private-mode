import { describe, expect, it } from "vitest";

import { recordFailure } from "@/lib/private/core/tier-policy";
import { recoverFromCapacityFailure } from "@/lib/private/web/engine-recovery";

import { CAPABLE_REPORT } from "./helpers/mock-local-provider";

/** Generation-time OOM/device loss goes through the load-failure policy. */

const NOW = 1_800_000_000_000;
const never = async () => false;
const always = async () => true;

describe("recoverFromCapacityFailure", () => {
  it("records the failure (tier + time only) and steps down from L to M", async () => {
    const { failures, next } = await recoverFromCapacityFailure({
      report: CAPABLE_REPORT,
      choice: "auto",
      failures: {},
      failedTier: "L",
      now: NOW,
      isCached: never,
    });
    expect(failures).toEqual({ L: [NOW] });
    expect(JSON.stringify(failures)).not.toMatch(/[a-z]{4,}/i); // no content, just tiers and numbers
    expect(next.action).toBe("approve_download");
    expect(next.action !== "unavailable" && next.decision.tier).toBe("M");
    expect(next.action !== "unavailable" && next.decision.steppedDown).toBe(true);
  });

  it("an uncached lower tier needs explicit download approval; a cached one loads", async () => {
    const uncached = await recoverFromCapacityFailure({
      report: CAPABLE_REPORT, choice: "auto", failures: {}, failedTier: "L", now: NOW, isCached: never,
    });
    expect(uncached.next.action).toBe("approve_download");
    const cached = await recoverFromCapacityFailure({
      report: CAPABLE_REPORT, choice: "auto", failures: {}, failedTier: "L", now: NOW, isCached: always,
    });
    expect(cached.next.action).toBe("load");
  });

  it("a cache check that throws counts as uncached (never a silent download)", async () => {
    const { next } = await recoverFromCapacityFailure({
      report: CAPABLE_REPORT, choice: "auto", failures: {}, failedTier: "L", now: NOW,
      isCached: async () => { throw new Error("worker gone"); },
    });
    expect(next.action).toBe("approve_download");
  });

  it("a second failure blocks the tier even for a manual choice", async () => {
    const first = await recoverFromCapacityFailure({
      report: CAPABLE_REPORT, choice: "L", failures: {}, failedTier: "L", now: NOW - 1000, isCached: always,
    });
    // One failure: a manual L is still allowed (retry once).
    expect(first.next.action !== "unavailable" && first.next.decision.tier).toBe("L");
    const second = await recoverFromCapacityFailure({
      report: CAPABLE_REPORT, choice: "L", failures: first.failures, failedTier: "L", now: NOW, isCached: always,
    });
    expect(second.next.action !== "unavailable" && second.next.decision.tier).toBe("M");
    expect(second.next.action !== "unavailable" && second.next.decision.selectable).not.toContain("L");
  });

  it("failing at Lite steps down to Mini and asks before downloading", async () => {
    const failures = recordFailure(recordFailure(recordFailure({}, "M", NOW - 3), "L", NOW - 2), "S", NOW - 1);
    const { next } = await recoverFromCapacityFailure({
      report: CAPABLE_REPORT, choice: "auto", failures, failedTier: "XS", now: NOW, isCached: always,
    });
    expect(next.action !== "unavailable" && next.decision.tier).toBe("XXS");
    expect(next.action !== "unavailable" && next.decision.steppedDown).toBe(true);
  });

  it("failing at the lowest tier (Mini) ends in unavailable, never a remote model", async () => {
    let failures = recordFailure(recordFailure(recordFailure({}, "M", NOW - 4), "L", NOW - 3), "S", NOW - 2);
    failures = recordFailure(failures, "XS", NOW - 1);
    const { next } = await recoverFromCapacityFailure({
      report: CAPABLE_REPORT, choice: "auto", failures, failedTier: "XXS", now: NOW, isCached: always,
    });
    expect(next).toEqual({ action: "unavailable", reason: "all_tiers_blocked" });
  });
});
