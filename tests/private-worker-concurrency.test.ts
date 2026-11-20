import { expect, it, vi } from "vitest";
import { MODEL_CATALOG } from "@/lib/private/core/model-catalog";
const state = vi.hoisted(() => ({ reload: vi.fn(), remove: vi.fn(), complete: vi.fn(), prepare: vi.fn(), guard: vi.fn() }));
vi.mock("@mlc-ai/web-llm", () => ({
  IntegrityError: class extends Error {},
  MLCEngine: class { reload = state.reload; unload = vi.fn(async () => {}); },
}));
vi.mock("@/lib/private/web/artifact-integrity", () => ({ artifactAccess: () => state }));
it("queues deletion and cache checks behind an in-flight load", async () => {
  let finish!: () => void;
  state.reload.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const postMessage = vi.fn();
  const worker = { caches: {}, fetch: vi.fn(), postMessage, onmessage: null as unknown };
  vi.stubGlobal("self", worker);
  try {
    await import("@/lib/private/web/webllm-worker");
    const send = (data: unknown) => (worker.onmessage as (event: unknown) => void)({ data });
    const artifact = Object.values(MODEL_CATALOG[0].webllm)[0];
    send({ id: "load", type: "load", artifact, disableThinking: true });
    await vi.waitFor(() => expect(state.reload).toHaveBeenCalledOnce());
    send({ id: "delete", type: "delete_cache", artifact });
    send({ id: "check", type: "has_cache", artifact });
    await Promise.resolve();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.complete).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledOnce());
    expect(state.remove).toHaveBeenCalledOnce();
    expect(state.remove.mock.invocationCallOrder[0]).toBeLessThan(state.complete.mock.invocationCallOrder[0]);
    expect(postMessage).toHaveBeenCalledWith({ id: "load", type: "result", value: true });
  } finally { vi.unstubAllGlobals(); }
});
