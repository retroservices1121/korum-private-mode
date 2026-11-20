/**
 * Which on-device model Private Mode uses (portable core, pure).
 *
 * Private Mode defaults to the model built into the browser or device.
 * WebLLM tiers are opt-in upgrades. If neither on-device option can run,
 * the policy reports "unavailable".
 *
 * Providers:
 *   - `builtin-prompt-api`: the `LanguageModel` Prompt API. Used only in
 *     browsers whose vendor documents on-device inference: Google Chrome
 *     (Gemini Nano) and Microsoft Edge (Aion Instruct). The spec allows a
 *     browser to back the API with a cloud service and gives pages no way to
 *     tell, so any other browser exposing it is "not verified on-device" and
 *     is never used.
 *   - `builtin-apple-foundation`: Apple's Foundation Models via a future
 *     native iOS/macOS shell bridge. A type-level stub only; on the web it is
 *     always unavailable and it is not offered in the UI.
 *   - `webllm`: the pinned, R2-hosted WebLLM tiers (unchanged).
 */

import type { ModelDescriptorBase } from "./local-provider";
import type { TierDecision, UnavailableReason } from "./tier-policy";

export type PrivateProviderId = "builtin-prompt-api" | "builtin-apple-foundation" | "webllm";

/** Browsers whose vendor documents that the Prompt API model runs on the device. */
export type BuiltinVendor = "chrome" | "edge";

/** The one language list passed to every Prompt API call (availability, create). */
export const BUILTIN_LANGUAGES: readonly string[] = ["en"];

export const BUILTIN_MODEL: Record<
  BuiltinVendor,
  { id: string; modelName: string; displayName: string; browser: string; vendorName: string }
> = {
  chrome: {
    id: "builtin/chrome-gemini-nano",
    modelName: "Gemini Nano",
    displayName: "Gemini Nano (built into Chrome)",
    browser: "Chrome",
    vendorName: "Google",
  },
  edge: {
    id: "builtin/edge-aion-instruct",
    modelName: "Aion Instruct",
    displayName: "Aion Instruct (built into Edge)",
    browser: "Edge",
    vendorName: "Microsoft",
  },
};

/**
 * Privacy wording for the built-in models: the vendors' own statements,
 * quoted, nothing added. Chrome: developer.chrome.com/docs/ai/prompt-api.
 * Edge: learn.microsoft.com/en-us/microsoft-edge/web-platform/prompt-api.
 */
export const BUILTIN_PRIVACY_COPY: Record<BuiltinVendor, string> = {
  chrome:
    "Chrome runs Gemini Nano on your device. Google says: “Subsequent use of the model does not require a network connection. No data is sent to Google or any third party when using the model.”",
  edge: "Edge runs Aion Instruct on your device. Microsoft says: “The data input to the model never leaves the device.”",
};

/** Context window to assume before a built-in session reports its own. */
export const BUILTIN_DEFAULT_CONTEXT_TOKENS = 4096;

export interface BuiltinModelDescriptor extends ModelDescriptorBase {
  provider: "builtin-prompt-api";
  vendor: BuiltinVendor;
}

export function builtinDescriptor(vendor: BuiltinVendor, contextWindowTokens?: number): BuiltinModelDescriptor {
  const model = BUILTIN_MODEL[vendor];
  return {
    provider: "builtin-prompt-api",
    vendor,
    id: model.id,
    displayName: model.displayName,
    contextWindowTokens: contextWindowTokens ?? BUILTIN_DEFAULT_CONTEXT_TOKENS,
  };
}

/**
 * What the browser says about its built-in model.
 *   - `absent`: no `LanguageModel` API (Firefox, Safari, older Chrome, mobile).
 *   - `unverified`: the API exists, but the browser is not Chrome or Edge, so
 *     on-device inference is not documented; never used.
 *   - `unavailable` / `downloadable` / `downloading` / `available`: the
 *     browser's own `availability()` answer.
 */
export type BuiltinStatus =
  | { kind: "absent" }
  | { kind: "unverified" }
  | { kind: "unavailable"; vendor: BuiltinVendor }
  | { kind: "downloadable"; vendor: BuiltinVendor }
  | { kind: "downloading"; vendor: BuiltinVendor }
  | { kind: "available"; vendor: BuiltinVendor };

/** The built-in model can be used now, or after the browser's one-time download. */
export function builtinUsable(
  status: BuiltinStatus,
): status is Extract<BuiltinStatus, { kind: "downloadable" | "downloading" | "available" }> {
  return status.kind === "downloadable" || status.kind === "downloading" || status.kind === "available";
}

/** Remembered choice. `null`: never chosen, so the built-in model is the default. */
export type ProviderPreference = "builtin" | "webllm" | null;

type OkDecision = Extract<TierDecision, { status: "ok" }>;

export type ProviderPlan =
  /** Use the built-in model. `needsEnable`: the browser must download it first (needs a click). */
  | { kind: "builtin"; vendor: BuiltinVendor; needsEnable: boolean }
  /** A WebLLM tier already on this device: load it (no download). */
  | { kind: "webllm_load"; decision: OkDecision }
  /** No built-in model: the user picks a WebLLM tier and clicks to download it. */
  | { kind: "webllm_setup"; decision: OkDecision }
  /** Neither can run. Never the cloud. */
  | { kind: "unavailable"; builtin: BuiltinStatus; webllm: UnavailableReason | null };

export interface ProviderPlanInput {
  builtin: BuiltinStatus;
  webllm: TierDecision;
  /** Whether `webllm`'s chosen tier is fully cached on this device. */
  webllmCached: boolean;
  preference: ProviderPreference;
}

/**
 * Order:
 *   1. the user chose a WebLLM tier before and it is on this device → load it;
 *   2. a usable built-in model → the default;
 *   3. no built-in model, but a WebLLM tier is already on this device → load it
 *      without a download;
 *   4. no built-in model → WebLLM setup: the user picks a tier, then clicks;
 *   5. nothing → unavailable, with both reasons.
 */
export function planProvider(input: ProviderPlanInput): ProviderPlan {
  const { builtin, webllm } = input;
  if (input.preference === "webllm" && webllm.status === "ok" && input.webllmCached) {
    return { kind: "webllm_load", decision: webllm };
  }
  if (builtinUsable(builtin)) {
    return { kind: "builtin", vendor: builtin.vendor, needsEnable: builtin.kind !== "available" };
  }
  if (webllm.status === "ok") {
    return input.webllmCached ? { kind: "webllm_load", decision: webllm } : { kind: "webllm_setup", decision: webllm };
  }
  return { kind: "unavailable", builtin, webllm: webllm.reason };
}
