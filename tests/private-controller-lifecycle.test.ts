import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalRuntimeError } from "@/lib/private/core/local-provider";
import type { ThreadStore } from "@/lib/private/core/thread-schema";
import { PrivateChatController } from "@/lib/private/web/private-chat-controller";
import { IndexedDBThreadStore } from "@/lib/private/web/thread-store";

import { descriptor, MockLocalProvider } from "./helpers/mock-local-provider";

/**
 * A generation's final state is persisted no
 * matter which thread is on screen; deleted threads stay deleted; Stop works
 * during token counting; streaming state always clears.
 */

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

let store: IndexedDBThreadStore;
let provider: MockLocalProvider;

function controllerWith(s: ThreadStore = store, p = provider) {
  const c = new PrivateChatController({
    provider: p,
    store: s,
    profileKey: "anon",
    deviceId: "dev",
    writeClipboard: async () => {},
  });
  c.setModel(descriptor("M"));
  return c;
}

beforeEach(async () => {
  store = await IndexedDBThreadStore.open(new IDBFactory());
  provider = new MockLocalProvider();
});
afterEach(() => store.close());

describe("thread changes during generation", () => {
  it.each(["newThread", "selectThread"] as const)(
    "%s mid-stream persists the final content and status",
    async (action) => {
      const c = controllerWith();
      await c.init();
      provider.replies.push(["first answer"]);
      await c.send("first thread");
      const other = c.getState().activeThreadId!;
      await c.newThread();

      provider.replies.push(["streamed ", "tokens", "<wait>"]);
      const pending = c.send("second thread");
      await tick();
      const thread = c.getState().activeThreadId!;
      const streamingId = c.getState().streamingId!;
      expect(streamingId).toBeTruthy();

      if (action === "newThread") await c.newThread();
      else await c.selectThread(other);
      await pending;

      const saved = (await store.listMessages(thread)).find((m) => m.id === streamingId)!;
      expect(saved.status).toBe("complete");
      expect(saved.content).toBe("streamed tokens");
      expect(c.getState().streamingId).toBeNull();
      // The other thread on screen was not polluted by the old generation.
      expect(c.getState().messages.some((m) => m.id === streamingId)).toBe(false);
    },
  );

  it("deleting the streaming thread does not resurrect it", async () => {
    const c = controllerWith();
    await c.init();
    provider.replies.push(["partial", "<wait>"]);
    const pending = c.send("doomed");
    await tick();
    const thread = c.getState().activeThreadId!;

    await c.deleteThread(thread);
    await pending;
    await tick();

    expect(await store.getThread(thread)).toBeUndefined();
    expect(await store.listMessages(thread)).toEqual([]);
    expect(c.getState().threads).toEqual([]);
    expect(c.getState().streamingId).toBeNull();
  });
});

describe("stop and failure during preparation", () => {
  it("Stop during token counting prevents inference and clears streaming", async () => {
    let release!: (v: number[] | null) => void;
    provider.countTokens = () => new Promise<number[] | null>((r) => (release = r));
    const c = controllerWith();
    await c.init();

    const pending = c.send("hello");
    await tick();
    expect(c.getState().streamingId).not.toBeNull();
    c.stop();
    release([1, 1]);
    await pending;

    expect(provider.requests).toHaveLength(0);
    expect(c.getState().streamingId).toBeNull();
    const thread = c.getState().activeThreadId!;
    expect((await store.listMessages(thread)).map((m) => m.role)).toEqual(["user"]);
    expect(c.getState().messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("a token-count failure falls back to the estimate and still clears streaming", async () => {
    provider.countTokens = async () => {
      throw new Error("tokenizer gone");
    };
    provider.replies.push(["fine"]);
    const c = controllerWith();
    await c.init();
    await c.send("hello");
    expect(c.getState().streamingId).toBeNull();
    expect(c.getState().messages.at(-1)?.content).toBe("fine");
  });

  it("an IndexedDB write failure still clears streaming", async () => {
    let writes = 0;
    const flaky: ThreadStore = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
      putMessage: async (m: Parameters<ThreadStore["putMessage"]>[0]) => {
        if (++writes > 1) throw new Error("QuotaExceededError");
        return store.putMessage(m);
      },
    });
    provider.replies.push(["answer"]);
    const c = controllerWith(flaky);
    await c.init();
    await c.send("hello");
    expect(c.getState().streamingId).toBeNull();
    expect(c.getState().messages.at(-1)?.status).not.toBe("streaming");
  });

  it("a capacity failure during generation disables the model and reports the kind", async () => {
    const kinds: string[] = [];
    provider.failWith = new LocalRuntimeError("out_of_memory");
    const c = new PrivateChatController({
      provider,
      store,
      profileKey: "anon",
      deviceId: "dev",
      writeClipboard: async () => {},
      onRuntimeError: (e) => kinds.push(e.kind),
    });
    c.setModel(descriptor("L"));
    await c.init();
    await c.send("hello");
    expect(kinds).toEqual(["out_of_memory"]);
    provider.failWith = null;
    await c.send("again"); // model disabled until the app reloads one
    expect(provider.requests).toHaveLength(1);
  });
});
