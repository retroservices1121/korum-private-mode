/**
 * Derives a conversation title from its first user message.
 *
 * Deterministic on purpose: spending a model call on a title is the wrong
 * trade on a device-bound model, and a truncated question is a perfectly good
 * label. Pure and dependency-free so it can be unit tested in isolation.
 */
export function deriveTitle(firstMessage: string): string {
  const collapsed = firstMessage.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "New chat";
  if (collapsed.length <= 60) return collapsed;

  const cut = collapsed.slice(0, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
