// @vitest-environment happy-dom
import { IDBFactory } from "fake-indexeddb";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Composer, type ComposerHandle } from "@/components/chat/composer";
import type { ThreadStore } from "@/lib/private/core/thread-schema";
import { PrivateChatController, SAVE_FAILED_MESSAGE } from "@/lib/private/web/private-chat-controller";
import { submitPrivateMessage } from "@/lib/private/web/submit";
import { IndexedDBThreadStore } from "@/lib/private/web/thread-store";

import { descriptor, MockLocalProvider } from "./helpers/mock-local-provider";

/**
 * If the first history write fails (e.g. IndexedDB quota),
 * the prompt must not be lost. It is not sent to the model, the draft comes
 * back, and the error is content-free.
 */

const PROMPT = "my private question KORUM-CANARY-save";

let real: IndexedDBThreadStore;
let provider: MockLocalProvider;

function quota(): Error {
  const error = new Error("QuotaExceededError");
  error.name = "QuotaExceededError";
  return error;
}

/** A store whose Nth write (putThread or putMessage, counted together) throws. */
function failingStore(failOnWrite: number): ThreadStore {
  let writes = 0;
  const gate = () => {
    if (++writes === failOnWrite) throw quota();
  };
  return {
    listThreads: (k) => real.listThreads(k),
    getThread: (id) => real.getThread(id),
    putThread: async (t) => {
      gate();
      return real.putThread(t);
    },
    deleteThread: (id) => real.deleteThread(id),
    listMessages: (id) => real.listMessages(id),
    putMessage: async (m) => {
      gate();
      return real.putMessage(m);
    },
    deleteMessage: (id) => real.deleteMessage(id),
    recoverInterrupted: () => real.recoverInterrupted(),
    getMeta: (k) => real.getMeta(k),
    setMeta: (k, v) => real.setMeta(k, v),
    clearProfile: (k) => real.clearProfile(k),
  };
}

async function controllerOn(store: ThreadStore) {
  const c = new PrivateChatController({
    provider,
    store,
    profileKey: "anon",
    deviceId: "dev",
    writeClipboard: async () => {},
  });
  c.setModel(descriptor("M"));
  await c.init();
  return c;
}

beforeEach(async () => {
  real = await IndexedDBThreadStore.open(new IDBFactory());
  provider = new MockLocalProvider();
});
afterEach(() => real.close());

describe("first history write fails", () => {
  it.each([
    ["the new thread record (very first write)", 1],
    ["the first user message", 2],
  ])("%s → save_failed, nothing sent to the model, transcript unchanged", async (_what, n) => {
    const c = await controllerOn(failingStore(n));
    const result = await c.send(PROMPT);

    expect(result).toEqual({ status: "save_failed" });
    expect(provider.requests).toHaveLength(0);
    expect(c.getState().messages).toEqual([]);
    expect(c.getState().streamingId).toBeNull();
  });

  it("the draft is restored and the error says so without echoing the prompt", async () => {
    const c = await controllerOn(failingStore(1));
    const restored: string[] = [];
    const errors: string[] = [];
    await submitPrivateMessage(c, PROMPT, {
      getDraft: () => "",
      restoreDraft: (t) => restored.push(t),
      showError: (m) => errors.push(m),
    });
    expect(restored).toEqual([PROMPT]);
    expect(errors).toEqual([SAVE_FAILED_MESSAGE]);
    expect(SAVE_FAILED_MESSAGE).toMatch(/Couldn't save to this device/);
    expect(SAVE_FAILED_MESSAGE).not.toContain("KORUM-CANARY");
  });

  it("an unexpected rejection is handled the same way (no unhandled rejection)", async () => {
    const restored: string[] = [];
    const errors: string[] = [];
    await submitPrivateMessage(
      { send: async () => Promise.reject(new Error("boom")), viewVersion: 0 },
      PROMPT,
      { getDraft: () => "", restoreDraft: (t) => restored.push(t), showError: (m) => errors.push(m) },
    );
    expect(restored).toEqual([PROMPT]);
    expect(errors).toEqual([SAVE_FAILED_MESSAGE]);
  });

  it("a successful send does not restore the draft", async () => {
    const c = await controllerOn(real);
    const restored: string[] = [];
    await submitPrivateMessage(c, PROMPT, {
      getDraft: () => "",
      restoreDraft: (t) => restored.push(t),
      showError: () => {},
    });
    expect(restored).toEqual([]);
    expect(c.getState().messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("end to end in the Composer: the textarea gets the text back after a failed save", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const c = await controllerOn(failingStore(1));
    let done: Promise<void> = Promise.resolve();

    function Harness() {
      const ref = useRef<ComposerHandle>(null);
      return (
        <Composer
          handleRef={ref}
          streaming={false}
          onStop={() => {}}
          onSubmit={(text) => {
            done = submitPrivateMessage(c, text, {
              getDraft: () => ref.current?.getValue() ?? "",
              restoreDraft: (draft) => ref.current?.setValue(draft),
              showError: () => {},
            });
          }}
        />
      );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, PROMPT);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textarea.value).toBe(PROMPT);

    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await done;
      await new Promise((r) => setTimeout(r, 30)); // setValue focuses on the next frame
    });

    expect(textarea.value).toBe(PROMPT);
    expect(provider.requests).toHaveLength(0);
    await act(async () => root.unmount());
    container.remove();
  });
});
