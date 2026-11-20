import { MonitorX } from "lucide-react";

import { BUILTIN_MODEL, type BuiltinStatus } from "@/lib/private/core/provider-policy";
import type { UnavailableReason } from "@/lib/private/core/tier-policy";

/** Copy for the unavailable state. Exported for tests. */
export const UNAVAILABLE_HEADLINE = "Private Mode isn't available in this browser on this device.";
export const UNAVAILABLE_BODY =
  "Private Mode needs one of two things: a browser with a built-in AI model that runs on the device (desktop Chrome with Gemini Nano, or Edge with a built-in model), or a desktop browser with WebGPU, such as current Chrome or Edge, or Safari 26 on macOS, to run a model you download from KORUM.";

const DETAIL: Record<UnavailableReason, string> = {
  no_webgpu: "This browser does not offer WebGPU.",
  no_adapter: "WebGPU is present but no graphics adapter is available (it may be disabled by policy).",
  fallback_adapter: "Only a software graphics adapter is available, which is too slow for an on-device model.",
  insufficient_storage: "There is not enough free storage for the smallest on-device model.",
  all_tiers_blocked:
    "The on-device models failed to load here repeatedly. You can retry from Private Mode settings later.",
};

/** Why the browser's built-in model can't be used. Exported for tests. */
export function builtinDetail(status: BuiltinStatus): string {
  switch (status.kind) {
    case "absent":
      return "This browser has no built-in AI model that web pages can use. Desktop Chrome 148 or later has one (Gemini Nano).";
    case "unverified":
      return "This browser offers a built-in AI model, but KORUM can't verify that it runs on this device, so Private Mode doesn't use it.";
    case "unavailable":
      return status.vendor === "chrome"
        ? "Chrome says Gemini Nano can't run on this device. It needs Windows 10 or 11, macOS 13 or later, Linux, or a Chromebook Plus; 22 GB of free disk space; and a GPU with more than 4 GB of video memory, or 16 GB of RAM and 4 CPU cores."
        : `${BUILTIN_MODEL[status.vendor].browser} says its built-in model isn't available on this device.`;
    default:
      return "";
  }
}

/**
 * Hard stop when neither on-device model option can run.
 */
export function UnavailableState({
  reason,
  builtin = { kind: "absent" },
  builtinUnsupported = false,
  onRetryBlocked,
}: {
  reason: UnavailableReason;
  builtin?: BuiltinStatus;
  builtinUnsupported?: boolean;
  onRetryBlocked?: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-16 text-center" role="alert">
      <MonitorX className="text-muted-foreground size-10" aria-hidden />
      <h1 className="text-lg font-semibold tracking-tight">{UNAVAILABLE_HEADLINE}</h1>
      <p className="text-muted-foreground text-sm leading-6">{UNAVAILABLE_BODY}</p>
      <ul className="text-muted-foreground space-y-1 text-xs">
        <li data-unavailable="builtin">Built-in model: {builtinUnsupported ? "The browser’s built-in model couldn’t start on this device." : builtinDetail(builtin)}</li>
        <li data-unavailable="webllm">Downloadable models: {DETAIL[reason]}</li>
      </ul>
      <p className="text-muted-foreground text-xs">
        Nothing you type here is sent anywhere. Private Mode never falls back to a remote model.
      </p>
      {reason === "all_tiers_blocked" && onRetryBlocked && (
        <button type="button" className="text-sm underline" onClick={onRetryBlocked}>
          Retry the on-device models
        </button>
      )}
    </div>
  );
}
