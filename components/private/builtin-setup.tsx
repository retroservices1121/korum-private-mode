"use client";

import { Cpu, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { LocalRuntimeErrorKind } from "@/lib/private/core/local-provider";
import {
  BUILTIN_MODEL,
  BUILTIN_PRIVACY_COPY,
  type BuiltinModelKey,
  type BuiltinVendor,
} from "@/lib/private/core/provider-policy";

export function enableLabel(vendor: BuiltinVendor): string {
  return `Enable — ${BUILTIN_MODEL[vendor].browser} downloads it once`;
}

function errorText(vendor: BuiltinVendor, kind: LocalRuntimeErrorKind): string {
  const { browser } = BUILTIN_MODEL[vendor];
  switch (kind) {
    case "not_allowed":
      return `${browser} needs a click to start the model. Use the button to try again.`;
    case "download_failed":
      return vendor === "chrome"
        ? "Chrome couldn't download the model. Check that you're on an unmetered connection and try again."
        : "Edge couldn't download the model. Try again.";
    case "unsupported":
      return `${browser}'s built-in model doesn't support this setup.`;
    default:
      return `The built-in model couldn't start.`;
  }
}

/**
 * The browser's built-in model: its name, the vendor's own privacy wording
 * and its state (needs download / downloading with % / starting / error).
 * The download is done by the browser, after a click.
 */
export function BuiltinSetup({
  vendor,
  modelKey = vendor,
  status,
  phase,
  progress,
  error,
  onEnable,
  onShowUpgrades,
}: {
  vendor: BuiltinVendor;
  modelKey?: BuiltinModelKey;
  status: "downloadable" | "downloading" | "available" | "unavailable" | "absent" | "unverified";
  phase: "idle" | "loading" | "ready";
  progress: number | null;
  error: LocalRuntimeErrorKind | null;
  onEnable: () => void;
  onShowUpgrades?: () => void;
}) {
  const model = BUILTIN_MODEL[modelKey];
  const percent = progress === null ? null : Math.round(progress * 100);
  const downloading = phase === "loading" && (status !== "available" || progress !== null);

  return (
    <div className="mx-auto w-full max-w-xl space-y-4 px-4 py-10" data-builtin-state={phase === "idle" ? status : phase}>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Private Mode</h1>
        <p className="flex items-center gap-2 text-sm font-medium">
          <Cpu className="size-4" aria-hidden /> {model.displayName}
        </p>
        <p className="text-muted-foreground text-sm leading-6">{BUILTIN_PRIVACY_COPY[modelKey]}</p>
        <p className="text-muted-foreground text-sm leading-6">
          KORUM doesn&apos;t download this model. Your chats stay in this browser and are never sent
          to KORUM.
        </p>
      </div>

      {phase === "loading" ? (
        <div className="space-y-2" role="status">
          <div className="bg-muted h-2 overflow-hidden rounded-full">
            <div className="bg-foreground h-full transition-[width]" style={{ width: `${percent ?? 0}%` }} />
          </div>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {downloading
              ? `${model.browser} is downloading ${model.modelName}… ${percent ?? 0}%`
              : `Starting ${model.modelName}…`}
          </p>
        </div>
      ) : status === "downloadable" || status === "downloading" || (status === "available" && error) ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm leading-6">
            {status === "downloading"
              ? `${model.browser} has started downloading ${model.modelName}. Press Enable to use it and see the progress.`
              : status === "available"
                ? `${model.modelName} is on this device.`
                : vendor === "chrome"
                  ? "Chrome needs to download Gemini Nano once. Chrome does the download, not KORUM."
                  : `Edge needs to download ${modelKey === "edge-aion" ? model.modelName : "its built-in model"} before you can use it.`}
          </p>
          <Button className="w-full" onClick={onEnable}>
            {status === "available" ? `Start ${model.modelName}` : enableLabel(vendor)}
          </Button>
        </div>
      ) : null}

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {errorText(vendor, error)}
        </p>
      )}

      {onShowUpgrades && (
        <p className="text-muted-foreground text-xs leading-5">
          Prefer a larger open-weights model?{" "}
          <button type="button" className="underline underline-offset-2" onClick={onShowUpgrades}>
            Better quality options
          </button>{" "}
          (optional download from KORUM, 1 to 5 GB).
        </p>
      )}
    </div>
  );
}
