"use client";

import { ArrowUp, Square } from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MAX_HEIGHT_PX = 240;

export interface ComposerHandle {
  focus: () => void;
  setValue: (value: string) => void;
  /** The text currently in the box (read from the element, so it is never stale). */
  getValue: () => string;
}

export function Composer({
  onSubmit,
  onStop,
  streaming,
  handleRef,
  autoFocus,
  modeSlot,
  disabled = false,
  placeholder = "Ask anything...",
  footnote,
}: {
  onSubmit: (message: string) => void;
  onStop: () => void;
  streaming: boolean;
  handleRef?: RefObject<ComposerHandle | null>;
  autoFocus?: boolean;
  /** Shown at the bottom left of the box (Private Mode shows its status chip here). */
  modeSlot?: React.ReactNode;
  /** Disables typing and sending entirely. */
  disabled?: boolean;
  placeholder?: string;
  footnote?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");

  // Grow with the content up to a cap, then scroll inside the box.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  useImperativeHandle(handleRef, () => ({
    focus: () => textareaRef.current?.focus(),
    setValue: (next: string) => {
      setValue(next);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    getValue: () => textareaRef.current?.value ?? "",
  }));

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || streaming || disabled) return;
    setValue("");
    onSubmit(trimmed);
  }, [disabled, onSubmit, streaming, value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter breaks the line. IME composition must never be
    // interrupted, or typing in Japanese/Chinese submits half a word.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  // Keyboard-first: "/" from anywhere focuses the composer, Escape stops a
  // running generation.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (event.key === "/" && !typing) {
        event.preventDefault();
        textareaRef.current?.focus();
      }

      if (event.key === "Escape" && streaming) {
        event.preventDefault();
        onStop();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onStop, streaming]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className={cn(
          "bg-background rounded-[18px] border border-[oklch(0.9_0_0)] transition dark:border-[oklch(1_0_0/0.12)]",
          "shadow-[0_1px_2px_oklch(0_0_0/0.05),0_8px_24px_-12px_oklch(0_0_0/0.14)]",
          "focus-within:border-foreground/25 focus-within:ring-foreground/10 focus-within:ring-4",
        )}
      >
        <label htmlFor="korum-composer" className="sr-only">
          Ask anything
        </label>
        <textarea
          id="korum-composer"
          ref={textareaRef}
          rows={1}
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          className={cn(
            "w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[0.9375rem] leading-[1.7]",
            "placeholder:text-muted-foreground focus:outline-none",
          )}
        />

        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
          {modeSlot ?? <span />}

          {streaming ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="size-8 rounded-[10px]"
              onClick={onStop}
              aria-label="Stop generating"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              className="size-8 rounded-[10px]"
              disabled={disabled || value.trim().length === 0}
              aria-label="Send message"
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </form>

      {footnote && (
        <p className="text-muted-foreground mt-2.5 text-center text-[0.7188rem]">{footnote}</p>
      )}
    </div>
  );
}
