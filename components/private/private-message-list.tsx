"use client";

import { OnDeviceBadge } from "@/components/private/private-badges";
import { PrivateMarkdown } from "@/components/private/private-markdown";
import { PrivateMessageActions } from "@/components/private/private-message-actions";
import { findCatalogModel } from "@/lib/private/core/model-catalog";
import type { LocalMessage } from "@/lib/private/core/thread-schema";
import { cn } from "@/lib/utils";

export function PrivateMessageList({
  messages,
  streamingId,
  onCopy,
  onThumb,
  onRegenerate,
}: {
  messages: LocalMessage[];
  streamingId: string | null;
  onCopy: (id: string) => Promise<void>;
  onThumb: (id: string, thumb: "up" | "down" | null) => void;
  onRegenerate: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-7 px-4 py-8">
      {messages.map((message, index) => {
        if (message.role === "user") {
          return (
            <div key={message.id} className="flex flex-col items-end gap-1">
              <div className="bg-muted text-foreground max-w-[78%] rounded-[18px] rounded-br-md px-4 py-2.5 text-[0.9375rem] leading-[1.73] whitespace-pre-wrap">
                {message.content}
              </div>
              <OnDeviceBadge />
            </div>
          );
        }
        const streaming = message.id === streamingId;
        const isLast = index === messages.length - 1;
        const modelName = message.localModel
          ? (findCatalogModel(message.localModel)?.displayName ?? message.localModel)
          : null;
        return (
          <div key={message.id} className="group/message space-y-2">
            {message.status === "error" ? (
              <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm" role="status">
                {message.content}
              </p>
            ) : (
              <div className={cn("korum-prose text-[0.9375rem]", streaming && !message.content && "min-h-7")}>
                <PrivateMarkdown content={message.content} />
                {streaming && <span className="korum-caret" aria-hidden />}
              </div>
            )}
            {message.status === "interrupted" && (
              <p className="text-muted-foreground text-xs">
                This answer was interrupted.{isLast ? " Use Regenerate to try again." : ""}
              </p>
            )}
            {!streaming && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {message.status !== "error" && message.content && (
                  <PrivateMessageActions
                    thumb={message.thumb ?? null}
                    canRegenerate={isLast}
                    onCopy={() => onCopy(message.id)}
                    onThumb={(thumb) => onThumb(message.id, thumb)}
                    onRegenerate={onRegenerate}
                  />
                )}
                <OnDeviceBadge />
                {modelName && <span className="text-muted-foreground/70 text-xs">{modelName}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
