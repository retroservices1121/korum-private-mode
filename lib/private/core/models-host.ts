/**
 * Where Private Mode model artifacts are served from (a Cloudflare R2
 * bucket). Overridable at build time with NEXT_PUBLIC_KORUM_MODELS_BASE_URL (e.g.
 * a custom domain later). Never an upstream host: nothing at runtime talks to
 * Hugging Face or GitHub.
 */

export const DEFAULT_MODELS_BASE_URL = "https://pub-26cf84f7e330452fb4b2b8bc10a3c55b.r2.dev";

function configured(): string | undefined {
  try {
    // Written as a literal so Next inlines it into client and worker bundles.
    return process.env.NEXT_PUBLIC_KORUM_MODELS_BASE_URL;
  } catch {
    return undefined;
  }
}

export function normaliseBaseUrl(value: string | undefined): string {
  const base = (value?.trim() || DEFAULT_MODELS_BASE_URL).replace(/\/+$/, "");
  const url = new URL(base);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Model base URL must be https");
  }
  return base;
}

export const MODELS_BASE_URL = normaliseBaseUrl(configured());

/** Origin for CSP connect-src. */
export function modelsOrigin(base: string = MODELS_BASE_URL): string {
  return new URL(base).origin;
}
