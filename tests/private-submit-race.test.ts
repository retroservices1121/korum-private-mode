import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LocalMessage, ThreadStore } from "@/lib/private/core/thread-schema";
import {
  PrivateChatController,
  SAVE_FAILED_KEPT_MESSAGE,
  SAVE_FAILED_MESSAGE,
} from "@/lib/private/web/private-chat-controller";
import { submitPrivateMessage, type SubmitUI } from "@/lib/private/web/submit";
import { IndexedDBThreadStore } from "@/lib/private/web/thread-store";

import { descriptor, MockLocalProvider } from "./helpers/mock-local-provider";

/**
 * A failed save must not overwrite a newer draft typed
 * (or a thread opened) while the write was still pending.
 */

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PROMPT = "the prompt that failed to save";
let real: IndexedDBThreadStore;
let gate: ReturnType<typeof deferred>;

/** The first message write waits on `gate`, then fails. */
function pendingFailStore(): ThreadStore {
  let first = true;
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    listThreads: real.listThreads.bind(real),
    getThread: real.getThread.bind(real),
    putThread: real.putThread.bind(real),
    listMessages: real.listMessages.bind(real),
    deleteThread: real.deleteThread.bind(real),
    deleteMessage: real.deleteMessage.bind(real),
    recoverInterrupted: real.recoverInterrupted.bind(real),
    getMeta: real.getMeta.bind(real),
    setMeta: real.setMeta.bind(real),
    clearProfile: real.clearProfile.bind(real),
    putMessage: async (m: LocalMessage) => {
      if (first) {
        first = false;
        await gate.promise;
        throw new Error("QuotaExceededError");
      }
      return real.putMessage(m);
    },
  });
}

function fakeUI(initial = "") {
  const ui = {
    draft: initial,
    errors: [] as { message: string; action?: { label: string; onClick: () => void } }[],
    getDraft: () => ui.draft,
    restoreDraft: (t: string) => {
      ui.draft = t;
    },
    showError: (message: string, action?: { label: string; onClick: () => void }) => {
      ui.errors.push({ message, action });
    },
  };
  return ui satisfies SubmitUI;
}

async function controller() {
  const c = new PrivateChatController({
    provider: new MockLocalProvider(),
    store: pendingFailStore(),
    profileKey: "anon",
    deviceId: "dev",
    writeClipboard: async () => {},
  });
  c.setModel(descriptor("M"));
  await c.init();
  return c;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

beforeEach(async () => {
  real = await IndexedDBThreadStore.open(new IDBFactory());
  gate = deferred();
});
afterEach(() => real.close());

describe("failed save vs newer draft", () => {
  it("box still empty, same thread → the prompt goes back in the box", async () => {
    const c = await controller();
    const ui = fakeUI();
    const done = submitPrivateMessage(c, PROMPT, ui);
    await tick();
    gate.resolve(undefined);
    await done;
    expect(ui.draft).toBe(PROMPT);
    expect(ui.errors).toEqual([{ message: SAVE_FAILED_MESSAGE, action: undefined }]);
  });

  it("user typed a newer draft while the write was pending → newer draft kept, prompt behind 'Restore message'", async () => {
    const c = await controller();
    const ui = fakeUI();
    const done = submitPrivateMessage(c, PROMPT, ui);
    await tick();
    ui.draft = "something newer"; // typed while IndexedDB was pending
    gate.resolve(undefined);
    await done;

    expect(ui.draft).toBe("something newer");
    expect(ui.errors).toHaveLength(1);
    expect(ui.errors[0].message).toBe(SAVE_FAILED_KEPT_MESSAGE);
    expect(ui.errors[0].action?.label).toBe("Restore message");

    ui.errors[0].action!.onClick();
    expect(ui.draft).toBe(`something newer\n\n${PROMPT}`);
  });

  it("user moved to another thread while pending → box not touched, prompt still recoverable", async () => {
    const c = await controller();
    const ui = fakeUI();
    const done = submitPrivateMessage(c, PROMPT, ui);
    await tick();
    const switching = c.newThread();
    gate.resolve(undefined);
    await done;
    await switching;

    expect(ui.draft).toBe("");
    expect(ui.errors[0].action?.label).toBe("Restore message");
    ui.errors[0].action!.onClick();
    expect(ui.draft).toBe(PROMPT);
  });
});
