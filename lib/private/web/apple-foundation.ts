/**
 * STUB: Apple Foundation Models (`builtin-apple-foundation`) for a future
 * native iOS/macOS shell. Nothing here is implemented or
 * offered in the web UI.
 *
 * The intended design: the native shell hosts /private in a WKWebView and
 * exposes a message handler `window.webkit.messageHandlers.korumFoundationModels`
 * that runs Apple's on-device Foundation Models and streams text back. The
 * shell would implement `LocalProvider<AppleFoundationDescriptor>` on top of
 * it, with the same content-free error kinds.
 *
 * Until that bridge exists and is specified, detection ALWAYS reports
 * unavailable on the web, even if a page-visible object with that name is
 * present: a page script could define it, so its mere presence proves nothing.
 */

import type { ModelDescriptorBase } from "@/lib/private/core/local-provider";

export interface AppleFoundationBridge {
  postMessage(message: unknown): void;
}

export interface AppleFoundationDescriptor extends ModelDescriptorBase {
  provider: "builtin-apple-foundation";
}

export type AppleFoundationStatus = {
  kind: "unavailable";
  /** `no_bridge`: not in the native shell. `not_implemented`: bridge seen, provider not built yet. */
  reason: "no_bridge" | "not_implemented";
};

interface WebkitLike {
  webkit?: { messageHandlers?: { korumFoundationModels?: AppleFoundationBridge } };
}

export function detectAppleFoundation(win: WebkitLike = globalThis as unknown as WebkitLike): AppleFoundationStatus {
  const bridge = win.webkit?.messageHandlers?.korumFoundationModels;
  return { kind: "unavailable", reason: bridge ? "not_implemented" : "no_bridge" };
}
