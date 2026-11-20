import type { EngineArtifact } from "../core/model-pins";

export class ArtifactIntegrityError extends Error {
  name = "IntegrityError";
  constructor() { super("A model file failed its integrity check and was removed. Download again?"); }
}

/** Return a response backed by the very bytes hashed, eliminating a second cache read. */
export async function verifyArtifact(cache: Pick<Cache, "delete">, pin: EngineArtifact, response: Response): Promise<Response> {
  const bytes = await response.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  if (bytes.byteLength !== pin.bytes || hash !== pin.sha256) {
    await cache.delete(pin.url);
    throw new ArtifactIntegrityError();
  }
  return new Response(bytes, { headers: response.headers, status: response.status });
}

/** Bound before installing the worker's engine-only cache/network guard. */
export function artifactAccess(storage: CacheStorage, network: typeof fetch) {
  const open = storage.open.bind(storage);
  let activePins: EngineArtifact[] = [];
  const access = {
    async prepare(pins: EngineArtifact[], progress: (fraction: number) => void, signal: AbortSignal) {
      for (const [i, pin] of pins.entries()) {
        signal.throwIfAborted();
        progress(i / pins.length);
        const cache = await open(pin.cache);
        let response = await cache.match(pin.url);
        if (!response) {
          response = await network(pin.url, { signal, credentials: "omit", redirect: "error", cache: "no-store" });
          if (!response.ok) throw new Error("Model download failed");
          await cache.put(pin.url, await verifyArtifact(cache, pin, response));
        } else {
          await verifyArtifact(cache, pin, response);
        }
      }
    },
    async remove(pins: EngineArtifact[]) {
      for (const pin of pins) await (await open(pin.cache)).delete(pin.url);
    },
    async complete(pins: EngineArtifact[]) {
      for (const pin of pins) if (!await (await open(pin.cache)).match(pin.url)) return false;
      return true;
    },
    /** WebLLM 0.2.88 uses caches.open(scope).match(Request) then consumes its response.
     * Verify every engine read, including repeated loads and entries replaced by another tab.
     * Never let Cache.add silently download an evicted artifact. Other methods retain native this.
     */
    guard(pins: EngineArtifact[]) {
      activePins = pins;
    },
  };
  storage.open = async (name: string) => {
    const cache = await open(name);
    if (!name.startsWith("webllm/")) return cache;
    return new Proxy(cache, { get(target, prop) {
      if (prop === "match") return async (request: RequestInfo | URL) => {
        const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
        const pin = activePins.find((p) => p.cache === name && p.url === url);
        if (!pin) throw new Error("Unpinned model artifact refused");
        const response = await target.match(request);
        if (!response) throw new Error("Model cache entry missing; download again");
        return verifyArtifact(target, pin, response);
      };
      if (prop === "add" || prop === "addAll" || prop === "put") return async () => { throw new Error("Engine network/cache writes refused"); };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  return access;
}
