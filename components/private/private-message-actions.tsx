"use client";

import { Check, Copy, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Message actions for Private Mode.
 *
 * Presentation only: every effect is an injected handler. There is no fetch
 * and no analytics here. Thumbs are stored on the local message, copy is a
 * clipboard write, regenerate re-runs on this device.
 */
export function PrivateMessageActions({
  thumb,
  canRegenerate,
  onCopy,
  onThumb,
  onRegenerate,
}: {
  thumb: "up" | "down" | null;
  canRegenerate: boolean;
  onCopy: () => Promise<void> | void;
  onThumb: (next: "up" | "down" | null) => void;
  onRegenerate: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const button = "text-muted-foreground hover:text-foreground size-7";

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        className={button}
        aria-label={copied ? "Copied" : "Copy"}
        title="Copy"
        onClick={() => {
          void Promise.resolve(onCopy()).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn(button, thumb === "up" && "text-foreground bg-muted")}
        aria-label="Helpful"
        title="Helpful (saved on this device only)"
        aria-pressed={thumb === "up"}
        onClick={() => onThumb(thumb === "up" ? null : "up")}
      >
        <ThumbsUp className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn(button, thumb === "down" && "text-foreground bg-muted")}
        aria-label="Not helpful"
        title="Not helpful (saved on this device only)"
        aria-pressed={thumb === "down"}
        onClick={() => onThumb(thumb === "down" ? null : "down")}
      >
        <ThumbsDown className="size-3.5" />
      </Button>
      {canRegenerate && (
        <Button
          variant="ghost"
          size="icon"
          className={button}
          aria-label="Regenerate"
          title="Regenerate on this device"
          onClick={onRegenerate}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
