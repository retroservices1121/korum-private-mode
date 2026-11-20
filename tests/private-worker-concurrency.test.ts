import { expect, it, vi } from "vitest";
import { MODEL_CATALOG } from "@/lib/private/core/model-catalog";
const state = vi.hoisted(() => ({ reload: vi.fn(), remove: vi.fn(), prepare: vi.fn(), guard: vi.fn() }));
vi.mock("@mlc-ai/web-llm", () => ({
  IntegrityError: class extends Error {},
  MLCEngine: class { reload = state.reload; unload = vi.fn(async () => {}); },
}));
vi.mock("@/lib/private/web/artifact-integrity", () => ({ artifactAccess: () => state }));
it("queues deletion behind an in-flight load", async () => {
  let finish!: () => void;
  state.reload.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const postMessage = vi.fn();
  const worker = { caches: {}, fetch: vi.fn(), postMessage, onmessage: null as unknown };
  vi.stubGlobal("self", worker);
  try {
    await import("@/lib/private/web/webllm-worker");
    const send = (data: unknown) => (worker.onmessage as (event: unknown) => void)({ data });
    const artifact = Object.values(MODEL_CATALOG[0].webllm)[0];
    send({ id: "load", type: "load", artifact, disableThinking: true, allowDownload: false });
    await vi.waitFor(() => expect(state.reload).toHaveBeenCalledOnce());
    expect(state.prepare).toHaveBeenCalledWith(expect.any(Array), expect.any(Function), expect.any(AbortSignal), false);
    send({ id: "delete", type: "delete_cache", artifact });
    await Promise.resolve();
    expect(state.remove).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(state.remove).toHaveBeenCalledOnce());
    expect(postMessage).toHaveBeenCalledWith({ id: "load", type: "result", value: true });
  } finally { vi.unstubAllGlobals(); }
});
