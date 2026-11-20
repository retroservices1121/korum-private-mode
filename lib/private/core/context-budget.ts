/**
 * Context budgeting for the on-device model. Portable core.
 *
 * Counts with the loaded model's own tokenizer when the runtime exposes it,
 * otherwise with a deliberately pessimistic estimate. Reserves the chat
 * template, the system prompt and the output budget, then drops the OLDEST
 * turns first. If the newest user message alone does not fit, it says so —
 * it never truncates silently.
 */

import type { AIMessage } from "@/lib/ai/types";

/** Per-message chat-template overhead (role markers, separators). Generous on purpose. */
export const TEMPLATE_TOKENS_PER_MESSAGE = 12;
/** Fixed template overhead (BOS, generation prompt, `/no_think` style switches). */
export const TEMPLATE_TOKENS_FIXED = 32;

/**
 * Conservative token estimate when no tokenizer is available: UTF-8 bytes / 2.
 * English (~4 bytes/token) is overestimated ~2x, CJK (3 bytes/char, ~1
 * token/char) ~1.5x, emoji (4 bytes, 1–3 tokens) about right. Overestimating
 * only costs history; underestimating overflows the context.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 2);
}

export interface BudgetInput {
  system: string;
  /** Full history, oldest first; the last entry is the new user message. */
  history: AIMessage[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** Token counts aligned with [system, ...history], or null to estimate. */
  counts: number[] | null;
}

export type BudgetResult =
  | { ok: true; messages: AIMessage[]; promptTokens: number; droppedTurns: number }
  | { ok: false; reason: "too_long"; messageTokens: number; limitTokens: number };

export function localBudget(input: BudgetInput): BudgetResult {
  const texts = [input.system, ...input.history.map((m) => m.content)];
  const counts =
    input.counts && input.counts.length === texts.length
      ? input.counts
      : texts.map(estimateTokens);

  const cost = (index: number) => counts[index] + TEMPLATE_TOKENS_PER_MESSAGE;
  const available =
    input.contextWindowTokens - input.maxOutputTokens - TEMPLATE_TOKENS_FIXED - cost(0);

  const newestIndex = input.history.length; // index into counts
  const newestCost = cost(newestIndex);
  if (input.history.length === 0 || newestCost > available) {
    return {
      ok: false,
      reason: "too_long",
      messageTokens: counts[newestIndex] ?? 0,
      limitTokens: Math.max(0, available - TEMPLATE_TOKENS_PER_MESSAGE),
    };
  }

  let used = newestCost;
  let first = input.history.length - 1;
  for (let i = input.history.length - 2; i >= 0; i--) {
    const next = cost(i + 1);
    if (used + next > available) break;
    used += next;
    first = i;
  }

  let kept = input.history.slice(first);
  // A window must not open on a dangling assistant turn.
  while (kept.length > 1 && kept[0].role === "assistant") kept = kept.slice(1);

  return {
    ok: true,
    messages: [{ role: "system", content: input.system }, ...kept],
    promptTokens: used + cost(0) + TEMPLATE_TOKENS_FIXED,
    droppedTurns: input.history.length - kept.length,
  };
}

export function tooLongMessage(messageTokens: number, limitTokens: number): string {
  return `This message is too long for the on-device model (${messageTokens} of ${limitTokens} tokens). Shorten it or split it into parts.`;
}
