/**
 * Messages between the Private Mode page and `webllm-worker.ts`. A KORUM-owned
 * protocol (rather than WebLLM's own worker wrapper) so the page can ask for
 * token counts, cache presence and content-free error kinds.
 *
 * Error frames carry a `LocalRuntimeErrorKind` only, never runtime text, which
 * can echo model input.
 */

import type { AIMessage } from "@/lib/ai/types";
import type { LocalRuntimeErrorKind } from "@/lib/private/core/local-provider";
import type { WebLLMArtifact } from "@/lib/private/core/model-catalog";

export type WorkerRequest =
  | { id: number; type: "load"; artifact: WebLLMArtifact; disableThinking: boolean }
  | { id: number; type: "cancel_load" }
  | { id: number; type: "has_cache"; artifact: WebLLMArtifact }
  | { id: number; type: "delete_cache"; artifact: WebLLMArtifact }
  | { id: number; type: "count_tokens"; texts: string[] }
  | {
      id: number;
      type: "generate";
      messages: AIMessage[];
      maxTokens: number;
      temperature?: number;
    }
  | { id: number; type: "interrupt" }
  | { id: number; type: "unload" };

export type WorkerResponse =
  | { id: number; type: "progress"; fraction: number; text: string }
  | { id: number; type: "delta"; text: string }
  | {
      id: number;
      type: "generated";
      finishReason: "stop" | "length" | "unknown";
      tokens: { input: number; output: number };
    }
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "error"; kind: LocalRuntimeErrorKind }
  /** Unsolicited: the GPU device was lost after load. */
  | { id: -1; type: "device_lost" };
