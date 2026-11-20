/**
 * Thread export: the only backup of local history. Produces text;
 * the shell turns it into a local file download. Nothing is uploaded.
 */

import { SCHEMA_VERSION, type LocalMessage, type LocalThread } from "./thread-schema";

export function threadToJSON(thread: LocalThread, messages: LocalMessage[]): string {
  return JSON.stringify(
    {
      format: "korum-private-thread",
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      thread,
      messages,
    },
    null,
    2,
  );
}

export function threadToMarkdown(thread: LocalThread, messages: LocalMessage[]): string {
  const lines = [`# ${thread.title}`, "", `_KORUM Private Mode · exported ${new Date().toISOString()}_`, ""];
  for (const message of messages) {
    const who = message.role === "user" ? "You" : `KORUM (on this device${message.localModel ? `, ${message.localModel}` : ""})`;
    lines.push(`## ${who}`, "", message.content, "");
    if (message.status === "interrupted") lines.push("_(interrupted)_", "");
  }
  return lines.join("\n");
}

export function exportFileName(thread: LocalThread, extension: "json" | "md"): string {
  const slug = thread.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "chat";
  return `korum-private-${slug}.${extension}`;
}
