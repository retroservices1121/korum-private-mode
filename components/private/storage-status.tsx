import { ShieldCheck, ShieldAlert } from "lucide-react";

import { PERSIST_COPY, type PersistState } from "@/lib/private/web/storage-persistence";

/**
 * Whether the browser has agreed not to clear Private Mode data.
 * When it hasn't (denied or unsupported), nudge the user to export.
 */
export function StorageStatus({
  state,
  canExport,
  onExport,
}: {
  state: PersistState;
  canExport: boolean;
  onExport: () => void;
}) {
  if (state === "checking") return null;
  if (state === "persisted") {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-[0.6875rem]" data-persist-state={state}>
        <ShieldCheck className="size-3.5 text-emerald-600" aria-hidden />
        {PERSIST_COPY.persisted}
      </p>
    );
  }
  return (
    <div className="space-y-0.5 text-[0.6875rem]" data-persist-state={state} role="note">
      <p className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
        <ShieldAlert className="size-3.5" aria-hidden />
        {PERSIST_COPY.notPersisted}
      </p>
      <p className="text-muted-foreground">
        {PERSIST_COPY.nudge}{" "}
        {canExport && (
          <button type="button" className="underline underline-offset-2" onClick={onExport}>
            Export this chat
          </button>
        )}
      </p>
    </div>
  );
}
