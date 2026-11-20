import { Lock, MonitorSmartphone } from "lucide-react";

import { cn } from "@/lib/utils";

/** Per-message origin badge: every answer in Private Mode is produced on this device. */
export function OnDeviceBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "text-muted-foreground inline-flex items-center gap-1 text-[0.6875rem] font-medium",
        className,
      )}
    >
      <MonitorSmartphone className="size-3" aria-hidden />
      On this device
    </span>
  );
}

/** Safari support is labelled as beta: it works, but is less tested and evicts site data more aggressively. */
export const SAFARI_BETA_TEXT = "Private Mode on Safari is in beta";

export function BetaBadge({ title = SAFARI_BETA_TEXT }: { title?: string }) {
  return (
    <span
      title={title}
      aria-label={title}
      className="rounded-full border border-amber-500/50 bg-amber-500/10 px-1.5 py-px text-[0.625rem] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-300"
    >
      Beta
    </span>
  );
}

/** Composer chip: "Private · On this device · {model}", plus "Beta" on Safari. */
export function PrivateChip({ model, beta = false }: { model: string | null; beta?: boolean }) {
  return (
    <span className="bg-muted text-foreground inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium">
      <Lock className="size-3" aria-hidden />
      Private · On this device{model ? ` · ${model}` : ""}
      {beta && <BetaBadge />}
    </span>
  );
}
