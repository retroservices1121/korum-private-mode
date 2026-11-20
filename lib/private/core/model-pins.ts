/**
 * Typed access to the generated model pins. Portable core.
 *
 * `model-pins.generated.json` is produced when the model artifacts are
 * mirrored to the models host, and is committed verbatim: every model is pinned to an exact upstream revision, every
 * file to its byte size and SHA-256, and every kernel library to an exact
 * commit. Runtime code only ever uses these pins with the R2 base URL.
 */

import pins from "./model-pins.generated.json";

export interface PinnedFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PinnedModel {
  modelId: string;
  hfRepo: string;
  revision: string;
  keyPrefix: string;
  bytes: number;
  files: PinnedFile[];
}

export interface PinnedLib {
  modelId: string;
  repo: string;
  commit: string;
  file: string;
  key: string;
  bytes: number;
  sha256: string;
}

export interface ModelPins {
  schema: "korum.model-pins";
  schemaVersion: 1;
  generatedAt: string;
  webllmVersion: string;
  keyLayout: { model: string; lib: string };
  models: PinnedModel[];
  libs: PinnedLib[];
}

export const MODEL_PINS = pins as ModelPins;

export function pinnedModel(modelId: string): PinnedModel {
  const model = MODEL_PINS.models.find((m) => m.modelId === modelId);
  if (!model) throw new Error(`No pins for ${modelId}`);
  return model;
}

export function pinnedLib(modelId: string): PinnedLib {
  const lib = MODEL_PINS.libs.find((l) => l.modelId === modelId);
  if (!lib) throw new Error(`No lib pin for ${modelId}`);
  return lib;
}

/** The WebLLM cache each engine-read artifact lives in. */
export type EngineCache = "webllm/config" | "webllm/model" | "webllm/wasm";

export interface EngineArtifact {
  cache: EngineCache;
  url: string;
  bytes: number;
  sha256: string;
  /** Short, content-free label for progress and errors. */
  label: string;
}

/** All pinned artifacts, including tokenizer sidecars and both tensor/ndarray manifests.
 * Config uses WebLLM's config cache; other model files use its model cache.
 */
export function engineArtifacts(modelId: string, baseUrl: string): EngineArtifact[] {
  const model = pinnedModel(modelId);
  const lib = pinnedLib(modelId);
  const root = `${baseUrl}/${model.keyPrefix}`;
  return [
    ...model.files.map((pin): EngineArtifact => ({
      cache: pin.path === "mlc-chat-config.json" ? "webllm/config" : "webllm/model",
      url: `${root}${pin.path}`,
      bytes: pin.bytes,
      sha256: pin.sha256,
      label: pin.path,
    })),
    {
      cache: "webllm/wasm",
      url: `${baseUrl}/${lib.key}`,
      bytes: lib.bytes,
      sha256: lib.sha256,
      label: lib.file,
    },
  ];
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** "sha256-<base64>" Subresource Integrity string from a hex digest (no Buffer/btoa needed). */
export function sriFromHex(hex: string): string {
  const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = bytes.slice(i, i + 3);
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return `sha256-${out}`;
}
