"use client";

import { Download, HardDrive, Loader2, X } from "lucide-react";

import { BetaBadge, SAFARI_BETA_TEXT } from "@/components/private/private-badges";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LocalRuntimeErrorKind } from "@/lib/private/core/local-provider";
import {
  artifactFor,
  formatBytes,
  modelForTier,
  TIER_ORDER,
  tierTitle,
  type ModelTier,
} from "@/lib/private/core/model-catalog";

export const SAFARI_STORAGE_NOTICE =
  "Safari may delete Private Mode data, including your private chats and the downloaded model, if you don't visit this site for 7 days. Add KORUM to the Dock or export chats you want to keep.";

const ERROR_TEXT: Partial<Record<LocalRuntimeErrorKind, string>> = {
  quota_exceeded: "There wasn't enough disk space. Free some space or pick a lighter model.",
  download_failed: "The download didn't finish. Check your connection and try again.",
  integrity_failed: "A model file failed its integrity check and was removed. Download again?",
  out_of_memory: "That model didn't fit in this device's memory, so KORUM stepped down a tier.",
  device_lost: "The GPU reset while loading, so KORUM stepped down a tier.",
  pipeline_failed: "The GPU couldn't run that model, so KORUM stepped down a tier.",
  worker_failed: "The on-device engine stopped unexpectedly. Try again.",
  unknown: "The on-device model couldn't start.",
};

export interface SetupProps {
  tier: ModelTier;
  recommended: ModelTier;
  selectable: ModelTier[];
  shaderF16: boolean;
  cached: boolean;
  phase: "idle" | "loading";
  progress: { fraction: number; text: string } | null;
  error: LocalRuntimeErrorKind | null;
  steppedDown: boolean;
  showSafariNotice: boolean;
  /** Safari: always show the beta label (not dismissible). */
  safariBeta?: boolean;
  clearedNotice: "partial" | "first_run" | null;
  onDownload: () => void;
  onCancel: () => void;
  onChooseTier: (tier: ModelTier) => void;
  onDismissSafari: () => void;
}

/** First-run flow: verdict, tier, size, explicit Download, progress, cancel. */
export function ModelSetup(props: SetupProps) {
  const model = modelForTier(props.tier);
  const size = formatBytes(artifactFor(model, props.shaderF16).downloadBytes);
  const loading = props.phase === "loading";

  return (
    <div className="mx-auto w-full max-w-xl space-y-4 px-4 py-10">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Set up Private Mode</h1>
        <p className="text-muted-foreground text-sm leading-6">
          Private Mode runs an AI model inside this browser tab, on this device. Your chats stay
          in this browser and are never sent to KORUM.
        </p>
      </div>

      {props.clearedNotice === "partial" && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          Some Private Mode data was cleared by the browser.
        </p>
      )}
      {props.clearedNotice === "first_run" && (
        <p className="text-muted-foreground text-xs">
          If you used Private Mode here before, your browser has cleared it.
        </p>
      )}

      {props.safariBeta && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="note">
          <BetaBadge />
          <p>
            {SAFARI_BETA_TEXT}. It works, but it is less tested than Chrome and Edge, and Safari
            is stricter about keeping site data.
          </p>
        </div>
      )}

      {props.showSafariNotice && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="note">
          <p>{SAFARI_STORAGE_NOTICE}</p>
          <button type="button" className="mt-2 text-xs underline" onClick={props.onDismissSafari}>
            Got it
          </button>
        </div>
      )}

      <fieldset className="space-y-2" disabled={loading}>
        <legend className="text-sm font-medium">Model</legend>
        {[...TIER_ORDER].reverse().map((tier) => {
          const entry = modelForTier(tier);
          const allowed = props.selectable.includes(tier);
          return (
            <label
              key={tier}
              className="has-[:checked]:border-foreground/40 flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="tier"
                  checked={props.tier === tier}
                  disabled={!allowed}
                  onChange={() => props.onChooseTier(tier)}
                />
                <span>
                  <span className={cn("font-medium", entry.qualityNote && "text-amber-700 dark:text-amber-300")}>
                    {tierTitle(tier)}
                  </span>{" "}
                  · {entry.displayName}
                  {tier === props.recommended && (
                    <span className="text-muted-foreground"> · Recommended for this device</span>
                  )}
                </span>
              </span>
              <span className="text-muted-foreground text-xs">
                {formatBytes(artifactFor(entry, props.shaderF16).downloadBytes)}
              </span>
            </label>
          );
        })}
      </fieldset>

      {props.error && (
        <p className="text-destructive text-sm" role="alert">
          {ERROR_TEXT[props.error] ?? ERROR_TEXT.unknown}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          <div className="bg-muted h-2 overflow-hidden rounded-full">
            <div
              className="bg-foreground h-full transition-[width]"
              style={{ width: `${Math.round((props.progress?.fraction ?? 0) * 100)}%` }}
            />
          </div>
          <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 truncate">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {props.progress?.text === "Checking model files…" ? "Checking model files…" : props.cached ? "Loading the model from this device…" : "Downloading…"}{" "}
              {Math.round((props.progress?.fraction ?? 0) * 100)}%
            </span>
            <Button variant="ghost" size="sm" onClick={props.onCancel}>
              <X className="size-3.5" /> Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={props.onDownload} className="w-full">
          {props.cached ? (
            <>
              <HardDrive className="size-4" /> Load {tierTitle(props.tier)} (already on this device)
            </>
          ) : (
            <>
              <Download className="size-4" /> {tierTitle(props.tier)} · {size} download
            </>
          )}
        </Button>
      )}

      <p className="text-muted-foreground text-xs leading-5">
        The model is downloaded once and stored by your browser. Your browser may clear Private
        Mode data when disk space runs low; export chats you want to keep.
      </p>
    </div>
  );
}
