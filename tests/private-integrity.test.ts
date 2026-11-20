import { describe, it, expect, vi } from "vitest";
import { artifactAccess, verifyArtifact } from "@/lib/private/web/artifact-integrity";
import { MODEL_PINS, engineArtifacts } from "@/lib/private/core/model-pins";
import { MODEL_CATALOG } from "@/lib/private/core/model-catalog";
import { MODELS_BASE_URL, modelsOrigin } from "@/lib/private/core/models-host";
import { PRIVATE_HEADERS } from "../next.config";

const good = new TextEncoder().encode("pinned bytes");
async function pin(label: string) {
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", good)).toString("hex");
  return { cache: "webllm/model" as const, url: `https://models.test/${label}`, label, bytes: good.length, sha256: hash };
}
describe("G2 integrity", () => {
  it("pins every catalog artifact with immutable revisions and exact sizes/hashes", () => {
    expect(MODEL_PINS.schemaVersion).toBe(1);
    expect(MODEL_PINS.webllmVersion).toBe("0.2.88");
    for (const model of MODEL_CATALOG) for (const artifact of Object.values(model.webllm)) {
      expect(artifact.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(JSON.stringify(artifact)).not.toMatch(/huggingface\.co|githubusercontent/);
      for (const p of engineArtifacts(artifact.modelId, MODELS_BASE_URL)) {
        expect(p.url.startsWith(`${MODELS_BASE_URL}/v1/`)).toBe(true);
        expect(p.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(p.bytes).toBeGreaterThan(0);
      }
    }
  });
  it("connect-src is exactly self plus configured R2 origin", () => {
    const csp = PRIVATE_HEADERS.find((h) => h.key === "Content-Security-Policy")!.value;
    expect(csp.split("; ").find((s) => s.startsWith("connect-src"))).toBe(`connect-src 'self' ${modelsOrigin()}`);
    for (const kind of ["img", "media", "frame"]) expect(csp).toContain(`${kind}-src 'none'`);
  });
  it.each(["params_shard_0.bin", "kernel.wasm", "mlc-chat-config.json"])("verifies and removes tampered %s", async (name) => {
    const p = await pin(name);
    const cache = { delete: vi.fn(async () => true) };
    expect(await (await verifyArtifact(cache, p, new Response(good))).text()).toBe("pinned bytes");
    await expect(verifyArtifact(cache, p, new Response("tampered"))).rejects.toMatchObject({ name: "IntegrityError" });
    expect(cache.delete).toHaveBeenCalledWith(p.url);
  });
  it("verifies downloads before storing, and refuses an evicted engine entry", async () => {
    const p = await pin("kernel.wasm");
    const entries = new Map<string, Response>();
    const cache = {
      match: async (url: string | Request) => entries.get(typeof url === "string" ? url : url.url)?.clone(),
      put: vi.fn(async (url: string, response: Response) => { entries.set(url, response); }),
      delete: vi.fn(async (url: string) => entries.delete(url)),
    };
    const storage = { open: async () => cache } as unknown as CacheStorage;
    const network = vi.fn(async () => new Response("bad download"));
    const access = artifactAccess(storage, network);
    await expect(access.prepare([p], () => {}, new AbortController().signal)).rejects.toMatchObject({ name: "IntegrityError" });
    expect(cache.put).not.toHaveBeenCalled();
    network.mockImplementation(async () => new Response(good));
    await access.prepare([p], () => {}, new AbortController().signal);
    expect(cache.put).toHaveBeenCalledOnce();
    expect(entries.has(p.url)).toBe(true);
    access.guard([p]);
    entries.clear();
    await expect(access.prepare([p], () => {}, new AbortController().signal, false))
      .rejects.toMatchObject({ name: "ArtifactCacheMissError" });
    await expect((await storage.open(p.cache)).match(p.url)).rejects.toThrow("missing");
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("verifies the actual engine cache read after an entry is replaced; refuses misses and writes", async () => {
    const p = await pin("params_shard_0.bin");
    let bytes = good;
    const cache = { match: vi.fn(async () => new Response(bytes)), delete: vi.fn(async () => true) };
    const storage = { open: async () => cache } as unknown as CacheStorage;
    const network = vi.fn();
    const access = artifactAccess(storage, network);
    await access.prepare([p], () => {}, new AbortController().signal);
    access.guard([p]);
    await access.remove([]);
    const guarded = await storage.open(p.cache);
    expect(await (await guarded.match(p.url))!.text()).toBe("pinned bytes");
    bytes = new TextEncoder().encode("replacement!");
    await expect(guarded.match(p.url)).rejects.toMatchObject({ name: "IntegrityError" });
    expect(cache.delete).toHaveBeenCalledWith(p.url);
    await expect(guarded.match("https://unapproved.test/file")).rejects.toThrow("Unpinned");
    await expect(guarded.add(p.url)).rejects.toThrow("refused");
    await expect((await storage.open(p.cache)).match(p.url)).rejects.toMatchObject({ name: "IntegrityError" });
    expect(network).not.toHaveBeenCalled();
  });
});
