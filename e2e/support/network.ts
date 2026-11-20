import { gunzipSync } from "node:zlib";

import type { BrowserContext, Request, Route } from "@playwright/test";

import { DEFAULT_MODELS_BASE_URL } from "../../lib/private/core/models-host";

export const R2_ORIGIN = new URL(DEFAULT_MODELS_BASE_URL).origin;

/** "self": this app's origin; "r2": the models host; "other": any third party. */
export type RequestKind = "self" | "r2" | "other";

export interface RecordedRequest {
  url: string;
  method: string;
  resourceType: string;
  headers: Record<string, string>;
  /** Raw body as latin1 text, or null. */
  body: string | null;
  /** Body after undoing common gzip/base64 transport encodings (for canary checks). */
  decodedBody: string | null;
  kind: RequestKind;
  fromServiceWorker: boolean;
  /** Date.now() when the browser issued it. */
  at: number;
}

export function classify(url: string, selfOrigin: string): RequestKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "other";
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") return "self";
  if (parsed.origin === selfOrigin) return "self";
  if (parsed.origin === R2_ORIGIN) return "r2";
  return "other";
}

/** Decodes gzip bodies and `compression=base64` form bodies, so a canary cannot hide in an encoding. */
export function decodeBody(url: string, raw: Buffer | null): string | null {
  if (!raw) return null;
  const parts = [raw.toString("latin1")];
  try {
    if (raw[0] === 0x1f && raw[1] === 0x8b) parts.push(gunzipSync(raw).toString("utf8"));
  } catch {
    // Not gzip after all.
  }
  const text = raw.toString("utf8");
  if (url.includes("compression=base64")) {
    const data = new URLSearchParams(text).get("data") ?? text;
    try {
      parts.push(Buffer.from(decodeURIComponent(data), "base64").toString("utf8"));
    } catch {
      parts.push(Buffer.from(data, "base64").toString("utf8"));
    }
  }
  return parts.join("\n");
}

/** Local stand-ins: nothing ever leaves the machine. */
async function stub(route: Route, kind: RequestKind) {
  if (kind === "r2") return route.fulfill({ status: 404, body: "" });
  return route.abort("blockedbyclient");
}

export interface NetworkGuard {
  readonly requests: RecordedRequest[];
  /** Waits for pending header/body reads. */
  settle(): Promise<RecordedRequest[]>;
  /** Requests that are not to this app's own origin. */
  external(): Promise<RecordedRequest[]>;
  /** Every request whose URL, headers or (decoded) body contains `needle`. */
  containing(needle: string): Promise<RecordedRequest[]>;
  /** Short printable list for assertion messages. */
  describe(list: RecordedRequest[]): string[];
}

/**
 * Records every request the context issues (pages and, in Chromium, service
 * workers) and answers every non-self request locally. Same-origin requests
 * continue to the local production server. WebKit does not expose worker-originated
 * traffic here; its offline checks prove delivery/headers, not complete traffic observation.
 */
export async function installNetworkGuard(context: BrowserContext, selfOrigin: string): Promise<NetworkGuard> {
  const requests: RecordedRequest[] = [];
  const pending: Promise<void>[] = [];

  context.on("request", (request: Request) => {
    const at = Date.now();
    pending.push(
      (async () => {
        const headers = await request.allHeaders().catch(() => request.headers());
        const raw = request.postDataBuffer();
        requests.push({
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          headers,
          body: raw ? raw.toString("latin1") : null,
          decodedBody: decodeBody(request.url(), raw),
          kind: classify(request.url(), selfOrigin),
          fromServiceWorker: request.serviceWorker() !== null,
          at,
        });
      })(),
    );
  });

  await context.route("**/*", async (route) => {
    const kind = classify(route.request().url(), selfOrigin);
    if (kind === "self") return route.fallback();
    return stub(route, kind);
  });

  const settle = async () => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
    return [...requests].sort((a, b) => a.at - b.at);
  };

  return {
    requests,
    settle,
    async external() {
      return (await settle()).filter((r) => r.kind !== "self");
    },
    async containing(needle: string) {
      return (await settle()).filter(
        (r) =>
          r.url.includes(needle) ||
          Object.entries(r.headers).some(([k, v]) => k.includes(needle) || v.includes(needle)) ||
          (r.body?.includes(needle) ?? false) ||
          (r.decodedBody?.includes(needle) ?? false),
      );
    },
    describe(list) {
      return list.map((r) => `${r.method} ${r.url.slice(0, 160)}${r.fromServiceWorker ? " (sw)" : ""}`);
    },
  };
}
