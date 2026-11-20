import { MonitorX } from "lucide-react";

import type { UnavailableReason } from "@/lib/private/core/tier-policy";

/** Copy for the unavailable state. Exported for tests. */
export const UNAVAILABLE_HEADLINE = "Private Mode isn't available in this browser on this device.";
export const UNAVAILABLE_BODY =
  "It needs a desktop browser with WebGPU, such as current Chrome or Edge, or Safari 26 on macOS.";

const DETAIL: Record<UnavailableReason, string> = {
  no_webgpu: "This browser does not offer WebGPU.",
  no_adapter: "WebGPU is present but no graphics adapter is available (it may be disabled by policy).",
  fallback_adapter: "Only a software graphics adapter is available, which is too slow for an on-device model.",
  insufficient_storage: "There is not enough free storage for the smallest on-device model.",
  all_tiers_blocked:
    "The on-device models failed to load here repeatedly. You can retry from Private Mode settings later.",
};

/**
 * Hard stop. Private Mode never falls back to a remote model: without a
 * usable on-device engine it says so and does nothing else.
 */
export function UnavailableState({
  reason,
  onRetryBlocked,
}: {
  reason: UnavailableReason;
  onRetryBlocked?: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-16 text-center" role="alert">
      <MonitorX className="text-muted-foreground size-10" aria-hidden />
      <h1 className="text-lg font-semibold tracking-tight">{UNAVAILABLE_HEADLINE}</h1>
      <p className="text-muted-foreground text-sm leading-6">{UNAVAILABLE_BODY}</p>
      <p className="text-muted-foreground text-xs">{DETAIL[reason]}</p>
      <p className="text-muted-foreground text-xs">
        Nothing you type here is sent anywhere. Private Mode never hands your messages to a server instead.
      </p>
      {reason === "all_tiers_blocked" && onRetryBlocked && (
        <button type="button" className="text-sm underline" onClick={onRetryBlocked}>
          Retry the on-device models
        </button>
      )}
    </div>
  );
}
