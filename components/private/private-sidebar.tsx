"use client";

import { FileDown, FileJson, PenSquare, Trash2 } from "lucide-react";

import { StorageStatus } from "@/components/private/storage-status";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import type { LocalThread } from "@/lib/private/core/thread-schema";
import type { PersistState } from "@/lib/private/web/storage-persistence";
import { cn } from "@/lib/utils";

/** Local thread list from IndexedDB. Reads and writes this device only; no server is involved. */
export function PrivateSidebar({
  threads,
  activeThreadId,
  onSelect,
  onNew,
  onDelete,
  onExport,
  persistState = "checking",
}: {
  threads: LocalThread[];
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onExport: (format: "json" | "md") => void;
  persistState?: PersistState;
}) {
  return (
    <div className="bg-sidebar text-sidebar-foreground flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <span className="px-1 text-sm font-semibold tracking-[0.18em] uppercase">Korum</span>
        <Button variant="ghost" size="icon" className="size-8" aria-label="New private chat" onClick={onNew}>
          <PenSquare className="size-4" />
        </Button>
      </div>
      <p className="text-muted-foreground px-4 pb-2 text-[0.6875rem] font-medium tracking-wide uppercase">
        Private chats · this device
      </p>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Private chats">
        {threads.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-xs">No private chats yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {threads.map((thread) => (
              <li key={thread.id} className="group flex items-center">
                <button
                  type="button"
                  onClick={() => onSelect(thread.id)}
                  className={cn(
                    "hover:bg-sidebar-accent min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm",
                    thread.id === activeThreadId && "bg-sidebar-accent font-medium",
                  )}
                >
                  {thread.title}
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`Delete ${thread.title}`}
                  onClick={() => onDelete(thread.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="border-sidebar-border space-y-2 border-t px-3 py-2.5">
        <StorageStatus
          state={persistState}
          canExport={activeThreadId !== null}
          onExport={() => onExport("md")}
        />
        {activeThreadId && (
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => onExport("md")}>
              <FileDown className="size-3.5" /> Export .md
            </Button>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => onExport("json")}>
              <FileJson className="size-3.5" /> Export .json
            </Button>
          </div>
        )}
        <div className="flex items-center justify-end">
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}
