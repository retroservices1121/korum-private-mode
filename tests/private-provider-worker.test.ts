import { describe, expect, it } from "vitest";

import { LocalRuntimeError } from "@/lib/private/core/local-provider";
import { WebLLMLocalProvider, type WorkerLike } from "@/lib/private/web/webllm-provider";
import type { WorkerRequest, WorkerResponse } from "@/lib/private/web/worker-protocol";

import { descriptor } from "./helpers/mock-local-provider";

/** A worker crash or startup failure settles every pending op. */

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: { preventDefault?: () => void }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  sent: WorkerRequest[] = [];
  terminated = false;
  autoLoad = true;

  postMessage(message: WorkerRequest) {
    this.sent.push(message);
    if (message.type === "load" && this.autoLoad) {
      queueMicrotask(() => this.reply({ id: message.id, type: "result", value: true }));
    }
  }
  reply(message: WorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
  }
  terminate() {
    this.terminated = true;
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const provider = new WebLLMLocalProvider(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  return { provider, workers };
}

const settle = <T,>(p: Promise<T>) =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

describe("WebLLMLocalProvider worker failures", () => {
  it.each(["error", "messageerror"] as const)(
    "worker %s rejects/settles load, cache check, token count and stream; resets; retries",
    async (event) => {
      const { provider, workers } = setup();
      let failures = 0;
      provider.onWorkerFailure = () => failures++;

      // A loaded model with a stream and a token count in flight.
      await provider.load(descriptor("M"), () => {});
      const stream = provider.stream({ messages: [{ role: "user", content: "hi" }], maxTokens: 8 });
      const streamed = settle(
        (async () => {
          for await (const chunk of stream) void chunk;
        })(),
      );
      await new Promise((r) => setTimeout(r, 0));
      const counted = provider.countTokens(["a"]);
      const cached = provider.isCached(descriptor("M"));
      workers[0].autoLoad = false;
      const loading = settle(provider.load(descriptor("S"), () => {}));
      await new Promise((r) => setTimeout(r, 0));

      const crash = workers[0];
      if (event === "error") crash.onerror?.({ preventDefault() {} });
      else crash.onmessageerror?.({});

      const s = await streamed;
      expect(s.ok).toBe(false);
      expect((s as { error: LocalRuntimeError }).error.kind).toBe("worker_failed");
      expect(await counted).toBeNull();
      expect(await cached).toBe(false);
      const l = await loading;
      expect(l.ok).toBe(false);
      expect((l as { error: LocalRuntimeError }).error.kind).toBe("worker_failed");
      // Content-free: the error carries only its kind.
      expect((l as { error: LocalRuntimeError }).error.message).toBe("worker_failed");

      expect(crash.terminated).toBe(true);
      expect(failures).toBe(1);

      // Loaded state was reset.
      await expect(
        (async () => {
          for await (const c of provider.stream({ messages: [], maxTokens: 1 })) void c;
        })(),
      ).rejects.toMatchObject({ kind: "not_loaded" });

      // Retry: the next operation spawns a fresh worker and works.
      await provider.load(descriptor("M"), () => {});
      expect(workers).toHaveLength(2);
      expect(workers[1].sent.at(-1)?.type).toBe("load");
    },
  );

  it("an error from an old, already-replaced worker is ignored", async () => {
    const { provider, workers } = setup();
    await provider.load(descriptor("M"), () => {});
    const old = workers[0];
    old.onerror?.({});
    await provider.load(descriptor("M"), () => {});
    old.onerror?.({}); // stale handler must not kill worker #2
    expect(workers[1].terminated).toBe(false);
  });
});
