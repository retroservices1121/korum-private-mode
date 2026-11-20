/// <reference lib="webworker" />
/**
 * Dedicated Web Worker that owns the GPU device and the WebLLM engine.
 * Inference stays off the main thread and away from React.
 *
 * Network: WebLLM fetches the model artifacts named in the catalog record
 * (and only those) into the Cache API. Nothing else leaves this worker; no
 * prompt or output is ever sent anywhere.
 */

import {
  IntegrityError,
  MLCEngine,
  type AppConfig,
  type ModelRecord,
} from "@mlc-ai/web-llm";

import type { LocalRuntimeErrorKind } from "@/lib/private/core/local-provider";
import type { WebLLMArtifact } from "@/lib/private/core/model-catalog";

import { recordModelUrl } from "./cache-completeness";
import { engineArtifacts } from "../core/model-pins";
import { MODELS_BASE_URL } from "../core/models-host";
import { artifactAccess } from "./artifact-integrity";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

declare const self: DedicatedWorkerGlobalScope;

let engine: MLCEngine | null = null;
let loadedModelId: string | null = null;
let disableThinking = true;
let cancelled = false;
let downloadController = new AbortController();
const access = artifactAccess(self.caches, self.fetch.bind(self));
// All network in this worker goes through the pinned downloader, including on cache eviction.
self.fetch = async () => { throw new Error("Engine network access refused"); };

function post(message: WorkerResponse) {
  self.postMessage(message);
}

function recordFor(artifact: WebLLMArtifact): ModelRecord {
  const { pins } = artifact;
  const integrity =
    pins.configSri || pins.modelLibSri || pins.tokenizerSri
      ? {
          ...(pins.configSri ? { config: pins.configSri } : {}),
          ...(pins.modelLibSri ? { model_lib: pins.modelLibSri } : {}),
          ...(pins.tokenizerSri ? { tokenizer: pins.tokenizerSri } : {}),
          onFailure: "error" as const,
        }
      : undefined;
  return {
    model: recordModelUrl(artifact),
    model_id: artifact.modelId,
    model_lib: artifact.modelLibUrl,
    vram_required_MB: artifact.vramRequiredMB,
    required_features: artifact.requiresShaderF16 ? ["shader-f16"] : [],
    overrides: { context_window_size: artifact.contextWindowTokens },
    ...(integrity ? { integrity } : {}),
  };
}

/** Only ever the catalog record: WebLLM must not resolve ids against its prebuilt list. */
function appConfigFor(artifact: WebLLMArtifact): AppConfig {
  return { model_list: [recordFor(artifact)], cacheBackend: "cache" };
}

function classify(error: unknown): LocalRuntimeErrorKind {
  // Not every WebLLM error class is exported, but each sets `name`.
  const name = (error as { name?: string })?.name ?? "";
  if (name === "ContextWindowSizeExceededError") return "context_exceeded";
  if (name === "DeviceLostError") return "device_lost";
  if (error instanceof IntegrityError || name === "IntegrityError") return "integrity_failed";
  const text = String((error as { message?: string })?.message ?? error).toLowerCase();
  if (name === "QuotaExceededError" || text.includes("quota")) return "quota_exceeded";
  if (name === "ArtifactCacheMissError") return "cache_missing";
  if (name === "AbortError") return "cancelled";
  if (text.includes("out of memory") || text.includes("oom") || text.includes("allocation")) {
    return "out_of_memory";
  }
  if (text.includes("device was lost") || text.includes("device lost")) return "device_lost";
  if (text.includes("pipeline") || text.includes("shader")) return "pipeline_failed";
  if (text.includes("fetch") || text.includes("network") || text.includes("http")) {
    return "download_failed";
  }
  return "unknown";
}

/** Reaches the loaded model's tokenizer. Not public API in 0.2.88, so it degrades to null. */
function tokenizer(): { encode(text: string): ArrayLike<number> } | null {
  const pipelines = (engine as unknown as {
    loadedModelIdToPipeline?: Map<string, { tokenizer?: { encode(text: string): ArrayLike<number> } }>;
  } | null)?.loadedModelIdToPipeline;
  if (!pipelines || !loadedModelId) return null;
  return pipelines.get(loadedModelId)?.tokenizer ?? null;
}

async function handle(request: WorkerRequest): Promise<void> {
  switch (request.type) {
    case "load": {
      cancelled = false;
      disableThinking = request.disableThinking;
      if (engine) await engine.unload().catch(() => undefined);
      engine = null;
      loadedModelId = null;
      downloadController = new AbortController();
      const pins = engineArtifacts(request.artifact.modelId, MODELS_BASE_URL);
      await access.prepare(pins, (fraction) => post({ id: request.id, type: "progress", fraction, text: "Checking model files…" }), downloadController.signal, request.allowDownload);
      access.guard(pins);
      engine = new MLCEngine({
        appConfig: appConfigFor(request.artifact),
        initProgressCallback: (report) =>
          post({ id: request.id, type: "progress", fraction: report.progress, text: report.text }),
        logLevel: "SILENT",
      });
      await engine.reload(request.artifact.modelId);
      // WebLLM's reload resolves quietly when aborted by unload().
      if (cancelled) {
        loadedModelId = null;
        post({ id: request.id, type: "error", kind: "cancelled" });
        return;
      }
      loadedModelId = request.artifact.modelId;
      post({ id: request.id, type: "result", value: true });
      return;
    }
    case "cancel_load": {
      cancelled = true;
      downloadController.abort();
      await engine?.unload().catch(() => undefined);
      post({ id: request.id, type: "result", value: true });
      return;
    }
    case "delete_cache": {
      await access.remove(engineArtifacts(request.artifact.modelId, MODELS_BASE_URL));
      post({ id: request.id, type: "result", value: true });
      return;
    }
    case "count_tokens": {
      const tok = tokenizer();
      const value = tok ? request.texts.map((text) => tok.encode(text).length) : null;
      post({ id: request.id, type: "result", value });
      return;
    }
    case "generate": {
      if (!engine || !loadedModelId) {
        post({ id: request.id, type: "error", kind: "not_loaded" });
        return;
      }
      const stream = await engine.chat.completions.create({
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
        // Qwen3 hybrid reasoning off. The display also strips <think>.
        ...(disableThinking ? { extra_body: { enable_thinking: false } } : {}),
      });
      let finishReason: "stop" | "length" | "unknown" = "unknown";
      let tokens = { input: 0, output: 0 };
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const text = choice?.delta?.content;
        if (text) post({ id: request.id, type: "delta", text });
        if (choice?.finish_reason === "stop" || choice?.finish_reason === "length") {
          finishReason = choice.finish_reason;
        }
        if (chunk.usage) {
          tokens = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
        }
      }
      post({ id: request.id, type: "generated", finishReason, tokens });
      return;
    }
    case "interrupt": {
      engine?.interruptGenerate();
      post({ id: request.id, type: "result", value: true });
      return;
    }
    case "unload": {
      await engine?.unload().catch(() => undefined);
      engine = null;
      loadedModelId = null;
      post({ id: request.id, type: "result", value: true });
      return;
    }
  }
}

let operationQueue = Promise.resolve();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const run = () => handle(request).catch((error: unknown) => {
    const kind = cancelled && request.type === "load" ? "cancelled" : classify(error);
    if (kind === "device_lost") loadedModelId = null;
    post({ id: request.id, type: "error", kind });
  });
  if (request.type === "load" || request.type === "delete_cache") {
    operationQueue = operationQueue.then(run);
  } else {
    void run();
  }
};
