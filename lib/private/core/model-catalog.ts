/** Pinned, self-hosted Private Mode model catalog (every artifact pinned by SHA-256). */
import { pinnedModel, pinnedLib, sriFromHex } from "./model-pins";
import { MODELS_BASE_URL } from "./models-host";

/**
 * XXS ("Mini", Qwen3-0.6B) is the smallest tier, so phones can run Private
 * Mode. It is the auto default on phones and on low-memory devices, and is
 * labelled "lowest quality".
 *
 * XS ("Lite", ~1.7B) is below the otherwise 3–8B range on purpose: it exists
 * for low-memory devices that cannot fit Light. It is labelled as lower quality wherever it is offered.
 */
export type ModelTier = "XXS" | "XS" | "S" | "M" | "L";

/** Smallest first; stepping down walks this right to left (L → M → S → XS → XXS). */
export const TIER_ORDER: readonly ModelTier[] = ["XXS", "XS", "S", "M", "L"] as const;

export const TIER_LABEL: Record<ModelTier, string> = {
  XXS: "Mini",
  XS: "Lite",
  S: "Light",
  M: "Balanced",
  L: "Best",
};

/** Bumped whenever an artifact URL, revision or pin changes. */
export const CATALOG_VERSION = "2026-11-21.1";

export interface ArtifactPins {
  /** SRI ("sha256-BASE64") of `mlc-chat-config.json`. */
  configSri: string | null;
  /** SRI of the kernel `.wasm`. */
  modelLibSri: string | null;
  /** SRI per tokenizer file name. */
  tokenizerSri: Record<string, string> | null;
  /** Hex SHA-256 for every pinned model file. */
  shardSha256: Record<string, string> | null;
}

export interface WebLLMArtifact {
  /** WebLLM `model_id`; also the Cache API key namespace. */
  modelId: string;
  quantization: "q4f16_1" | "q4f32_1";
  requiresShaderF16: boolean;
  /** Pinned R2 model base. */
  modelUrl: string;
  /** Pinned R2 kernel wasm. */
  modelLibUrl: string;
  /** Immutable upstream commit. Pinned by the generated manifest. */
  revision: string | null;
  /** KORUM-hosted versioned model base. */
  pinnedBaseUrl: string | null;
  vramRequiredMB: number;
  /** Exact pinned download size, bytes. */
  downloadBytes: number;
  contextWindowTokens: number;
  pins: ArtifactPins;
}

export interface CatalogModel {
  id: string;
  tier: ModelTier;
  displayName: string;
  /** Lab that trained the model (informational). */
  lab: string;
  license: string;
  /** Qwen3 is hybrid-reasoning; thinking must be turned off. */
  hybridThinking: boolean;
  /** Honest label shown next to the tier, e.g. "lower quality" for Lite. */
  qualityNote?: string;
  webllm: { f16: WebLLMArtifact; f32: WebLLMArtifact };
}

const GB = 1_000_000_000;

function webllm(
  modelId: string,
  quantization: WebLLMArtifact["quantization"],
  vramRequiredMB: number,
): WebLLMArtifact {
  const model = pinnedModel(modelId);
  const lib = pinnedLib(modelId);
  const base = `${MODELS_BASE_URL}/v1/models/${modelId}`;
  return {
    modelId,
    quantization,
    requiresShaderF16: quantization === "q4f16_1",
    modelUrl: base,
    modelLibUrl: `${MODELS_BASE_URL}/${lib.key}`,
    revision: model.revision,
    pinnedBaseUrl: base,
    vramRequiredMB,
    downloadBytes: model.bytes + lib.bytes,
    contextWindowTokens: 4096,
    pins: {
      configSri: sriFromHex(model.files.find((f) => f.path === "mlc-chat-config.json")!.sha256),
      modelLibSri: sriFromHex(lib.sha256),
      tokenizerSri: Object.fromEntries(model.files.filter((f) => f.path.startsWith("tokenizer.")).map((f) => [f.path, sriFromHex(f.sha256)])),
      shardSha256: Object.fromEntries(model.files.map((f) => [f.path, f.sha256])),
    },
  };
}

export const MODEL_CATALOG: readonly CatalogModel[] = [
  {
    id: "local/qwen3-0.6b",
    tier: "XXS",
    displayName: "Qwen3 0.6B",
    lab: "qwen",
    license: "Apache-2.0",
    hybridThinking: true,
    qualityNote: "lowest quality",
    webllm: {
      f16: webllm("Qwen3-0.6B-q4f16_1-MLC", "q4f16_1", 1403),
      f32: webllm("Qwen3-0.6B-q4f32_1-MLC", "q4f32_1", 1925),
    },
  },
  {
    id: "local/qwen3-1.7b",
    tier: "XS",
    displayName: "Qwen3 1.7B",
    lab: "qwen",
    license: "Apache-2.0",
    hybridThinking: true,
    qualityNote: "lower quality",
    webllm: {
      f16: webllm("Qwen3-1.7B-q4f16_1-MLC", "q4f16_1", 2037),
      f32: webllm("Qwen3-1.7B-q4f32_1-MLC", "q4f32_1", 2635),
    },
  },
  {
    id: "local/llama-3.2-3b",
    tier: "S",
    displayName: "Llama 3.2 3B",
    lab: "meta",
    license: "Llama 3.2 Community License",
    hybridThinking: false,
    webllm: {
      f16: webllm("Llama-3.2-3B-Instruct-q4f16_1-MLC", "q4f16_1", 2264),
      f32: webllm("Llama-3.2-3B-Instruct-q4f32_1-MLC", "q4f32_1", 2952),
    },
  },
  {
    id: "local/qwen3-4b",
    tier: "M",
    displayName: "Qwen3 4B",
    lab: "qwen",
    license: "Apache-2.0",
    hybridThinking: true,
    webllm: {
      f16: webllm("Qwen3-4B-q4f16_1-MLC", "q4f16_1", 3432),
      f32: webllm("Qwen3-4B-q4f32_1-MLC", "q4f32_1", 4328),
    },
  },
  {
    id: "local/qwen3-8b",
    tier: "L",
    displayName: "Qwen3 8B",
    lab: "qwen",
    license: "Apache-2.0",
    hybridThinking: true,
    webllm: {
      f16: webllm("Qwen3-8B-q4f16_1-MLC", "q4f16_1", 5696),
      f32: webllm("Qwen3-8B-q4f32_1-MLC", "q4f32_1", 6853),
    },
  },
];

export function modelForTier(tier: ModelTier): CatalogModel {
  const model = MODEL_CATALOG.find((entry) => entry.tier === tier);
  if (!model) throw new Error(`No catalog model for tier ${tier}`);
  return model;
}

/** "Best", "Balanced", "Light", "Lite: lower quality" or "Mini: lowest quality". */
export function tierTitle(tier: ModelTier): string {
  const note = modelForTier(tier).qualityNote;
  return note ? `${TIER_LABEL[tier]}: ${note}` : TIER_LABEL[tier];
}

export function findCatalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((entry) => entry.id === id);
}

/** The build to use on a device with or without `shader-f16`. */
export function artifactFor(model: CatalogModel, shaderF16: boolean): WebLLMArtifact {
  return shaderF16 ? model.webllm.f16 : model.webllm.f32;
}

/** "4.7 GB" style label for the setup screen. */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}
