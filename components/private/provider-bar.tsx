"use client";

import { Cpu, Loader2 } from "lucide-react";

import { BUILTIN_MODEL, builtinUsable } from "@/lib/private/core/provider-policy";
import { tierTitle } from "@/lib/private/core/model-catalog";
import { chatModelName, type EngineState } from "@/lib/private/web/engine-manager";

/**
 * One line under the header when there is a choice of on-device models:
 * which one answers, an upgrade download's progress, and the switch.
 */
export function ProviderBar({
  state,
  turnInProgress,
  onOpenUpgrade,
  onUseBuiltin,
  onUseWebLLM,
}: {
  state: EngineState;
  turnInProgress: boolean;
  onOpenUpgrade: () => void;
  onUseBuiltin: () => void;
  onUseWebLLM: () => void;
}) {
  const { builtin, webllm, active } = state;
  if (!builtinUsable(builtin.status)) return null;
  const builtinModel = BUILTIN_MODEL[builtin.status.vendor];
  const current = chatModelName(state);

  let action: React.ReactNode = null;
  const button = (label: string, onClick: () => void) => (
    <button type="button" className="underline underline-offset-2 disabled:opacity-50" disabled={turnInProgress} onClick={onClick}>
      {label}
    </button>
  );

  if (webllm?.kind === "setup" && webllm.phase === "loading") {
    const percent = Math.round((webllm.progress?.fraction ?? 0) * 100);
    action = (
      <span className="flex items-center gap-1.5" role="status">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        {webllm.cached ? "Loading" : "Downloading"} {webllm.decision.model.displayName} · {percent}%
        {!state.upgradeOpen && (
          <button type="button" className="underline underline-offset-2" onClick={onOpenUpgrade}>
            Details
          </button>
        )}
      </span>
    );
  } else if (active === "builtin" && webllm?.kind === "ready") {
    action = (
      <span className="flex items-center gap-1.5">
        {webllm.decision.model.displayName} is ready.{" "}
        {button(`Switch to ${webllm.decision.model.displayName}`, onUseWebLLM)}
      </span>
    );
  } else if (active === "webllm") {
    action = button(`Use ${builtinModel.modelName} instead`, onUseBuiltin);
  } else if (webllm?.kind === "setup" && !state.upgradeOpen) {
    action =
      webllm.cached === true
        ? button(`Switch to ${tierTitle(webllm.decision.tier)} (on this device)`, onUseWebLLM)
        : button("Better quality…", onOpenUpgrade);
  }

  return (
    <div
      className="border-border text-muted-foreground flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs"
      data-provider-bar
    >
      <span className="flex items-center gap-1.5">
        <Cpu className="size-3" aria-hidden />
        {current ? `On this device: ${current}` : "No model ready yet"}
      </span>
      {action}
    </div>
  );
}
