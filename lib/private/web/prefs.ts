/**
 * Private Mode preferences in localStorage: provider and tier
 * choice, failure memory and the device id. No content is ever written here.
 */

import { TIER_ORDER, type ModelTier } from "@/lib/private/core/model-catalog";
import type { ProviderPreference } from "@/lib/private/core/provider-policy";
import { ulid } from "@/lib/private/core/thread-schema";
import type { FailureHistory, TierChoice } from "@/lib/private/core/tier-policy";

const KEY = "korum-private-prefs";

export interface PrivatePrefs {
  deviceId: string;
  choice: TierChoice;
  /**
   * The model the user chose last: the browser's built-in one or a WebLLM
   * tier. `null` until they choose; the built-in model is then the default.
   */
  provider: ProviderPreference;
  failures: FailureHistory;
  /** The Safari storage notice was acknowledged. */
  safariNoticeSeen: boolean;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether prefs existed before this visit; used for best-effort storage-loss detection. */
export function prefsExist(): boolean {
  return Boolean(storage()?.getItem(KEY));
}

export function loadPrefs(): PrivatePrefs {
  const fallback: PrivatePrefs = { deviceId: ulid(), choice: "auto", provider: null, failures: {}, safariNoticeSeen: false };
  const raw = storage()?.getItem(KEY);
  if (!raw) {
    savePrefs(fallback);
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PrivatePrefs>;
    const tiers: readonly ModelTier[] = TIER_ORDER;
    const failures: FailureHistory = {};
    for (const tier of tiers) {
      const list = parsed.failures?.[tier];
      if (Array.isArray(list)) failures[tier] = list.filter((n) => typeof n === "number");
    }
    return {
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : fallback.deviceId,
      choice:
        typeof parsed.choice === "string" && (TIER_ORDER as readonly string[]).includes(parsed.choice)
          ? (parsed.choice as ModelTier)
          : "auto",
      provider: parsed.provider === "builtin" || parsed.provider === "webllm" ? parsed.provider : null,
      failures,
      safariNoticeSeen: parsed.safariNoticeSeen === true,
    };
  } catch {
    return fallback;
  }
}

export function savePrefs(prefs: PrivatePrefs): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked; failure memory is best effort.
  }
}
