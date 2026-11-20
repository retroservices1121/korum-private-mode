/**
 * Message types shared by the on-device model contract, the context budget
 * and the worker protocol. Types only: no runtime code, no network.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface AIMessage {
  role: ChatRole;
  content: string;
}

export type AIFinishReason = "stop" | "length" | "content_filter" | "error" | "unknown";
