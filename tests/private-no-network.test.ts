import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalRuntimeError } from "@/lib/private/core/local-provider";
import { PrivateChatController } from "@/lib/private/web/private-chat-controller";
import { IndexedDBThreadStore } from "@/lib/private/web/thread-store";

import { descriptor, MockLocalProvider } from "./helpers/mock-local-provider";
import { installNetworkTrap } from "./helpers/network-trap";

/**
 * Driving the whole private chat flow — send,
 * stream, stop, regenerate, thumbs, copy, export, thread new/switch/delete —
 * makes ZERO network requests of any kind.
 */

const CANARY = "KORUM-CANARY-7f3a9c";

let trap: ReturnType<typeof installNetworkTrap>;
let store: IndexedDBThreadStore;
let provider: MockLocalProvider;
let clipboard: string[];
let controller: PrivateChatController;

beforeEach(async () => {
  trap = installNetworkTrap();
  store = await IndexedDBThreadStore.open(new IDBFactory());
  provider = new MockLocalProvider();
  clipboard = [];
  controller = new PrivateChatController({
    provider,
    store,
    profileKey: "anon",
    deviceId: "device-test",
    writeClipboard: async (text) => {
      clipboard.push(text);
    },
  });
  controller.setModel(descriptor("M"));
  await controller.init();
});

afterEach(() => {
  store.close();
  trap.restore();
});

describe("Private Mode makes no network requests", () => {
  it("send → stream → stop → regenerate → thumbs → copy → export → threads", async () => {
    // send + stream
    provider.replies.push(["Hello ", "from ", `the device ${CANARY}`]);
    await controller.send(`Question with ${CANARY}`);
    let state = controller.getState();
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(state.messages[1].content).toBe(`Hello from the device ${CANARY}`);
    expect(state.messages[1].status).toBe("complete");
    expect(state.messages[1].origin).toBe("local");

    // stop mid-stream: the partial answer stays, marked complete
    provider.replies.push(["partial ", "<wait>"]);
    const pending = controller.send("Second question");
    await new Promise((r) => setTimeout(r, 20));
    expect(controller.getState().streamingId).not.toBeNull();
    controller.stop();
    await pending;
    state = controller.getState();
    expect(state.streamingId).toBeNull();
    expect(state.messages.at(-1)?.content).toBe("partial ");

    // regenerate replaces the last answer, on this device
    provider.replies.push(["regenerated"]);
    await controller.regenerate();
    state = controller.getState();
    expect(state.messages).toHaveLength(4);
    expect(state.messages.at(-1)?.content).toBe("regenerated");

    // thumbs and copy are local only
    const answerId = state.messages[1].id;
    await controller.setThumb(answerId, "up");
    await controller.setThumb(answerId, null);
    await controller.setThumb(answerId, "down");
    await controller.copy(answerId);
    expect(clipboard).toEqual([`Hello from the device ${CANARY}`]);
    const persisted = await store.listMessages(state.activeThreadId!);
    expect(persisted.find((m) => m.id === answerId)?.thumb).toBe("down");

    // export is a local string, not an upload
    const md = await controller.exportActive("md");
    const json = await controller.exportActive("json");
    expect(md?.text).toContain(CANARY);
    expect(JSON.parse(json!.text).messages).toHaveLength(4);

    // thread new / switch / delete
    const firstThread = state.activeThreadId!;
    await controller.newThread();
    expect(controller.getState().messages).toEqual([]);
    provider.replies.push(["second thread answer"]);
    await controller.send("Another thread");
    const secondThread = controller.getState().activeThreadId!;
    expect(secondThread).not.toBe(firstThread);
    expect(controller.getState().threads).toHaveLength(2);
    await controller.selectThread(firstThread);
    expect(controller.getState().messages).toHaveLength(4);
    await controller.deleteThread(secondThread);
    expect(controller.getState().threads.map((t) => t.id)).toEqual([firstThread]);
    expect(await store.listMessages(secondThread)).toEqual([]);

    // The only thing the model ever saw came from this device.
    expect(provider.requests.length).toBe(4);

    expect(trap.requests).toEqual([]);
  });

  it("an oversized message gets the 'too long' response, without calling the model or the network", async () => {
    await controller.send("x".repeat(40_000));
    const last = controller.getState().messages.at(-1)!;
    expect(last.status).toBe("error");
    expect(last.errorKind).toBe("context_exceeded");
    expect(last.content).toMatch(/too long for the on-device model \(\d+ of \d+ tokens\)/);
    expect(provider.requests).toHaveLength(0);
    expect(trap.requests).toEqual([]);
  });

  it("a runtime failure stays local: no retry against any remote service", async () => {
    provider.failWith = new LocalRuntimeError("device_lost");
    const errors: string[] = [];
    const failing = new PrivateChatController({
      provider,
      store,
      profileKey: "anon",
      deviceId: "device-test",
      writeClipboard: async () => {},
      onRuntimeError: (e) => errors.push(e.kind),
    });
    failing.setModel(descriptor("M"));
    await failing.init();
    await failing.send("hello");
    expect(errors).toEqual(["device_lost"]);
    expect(failing.getState().messages.at(-1)?.status).toBe("error");
    expect(trap.requests).toEqual([]);
  });

  it("does nothing at all without a loaded model (composer disabled state)", async () => {
    controller.setModel(null);
    await controller.send("hello");
    await controller.regenerate();
    expect(controller.getState().messages).toEqual([]);
    expect(provider.requests).toHaveLength(0);
    expect(trap.requests).toEqual([]);
  });
});
