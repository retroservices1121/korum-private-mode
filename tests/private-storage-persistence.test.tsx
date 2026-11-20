// @vitest-environment happy-dom
import { IDBFactory } from "fake-indexeddb";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StorageStatus } from "@/components/private/storage-status";
import { PrivateChatController } from "@/lib/private/web/private-chat-controller";
import { PERSIST_COPY, StoragePersistence } from "@/lib/private/web/storage-persistence";
import { IndexedDBThreadStore } from "@/lib/private/web/thread-store";

import { descriptor, MockLocalProvider } from "./helpers/mock-local-provider";

/** Ask the browser not to clear Private Mode data, at the right moments, once. */

function manager(opts: { persisted?: boolean; grant?: boolean; supported?: boolean } = {}) {
  if (opts.supported === false) return { storage: {}, persist: vi.fn(), persisted: vi.fn() };
  const persisted = vi.fn(async () => opts.persisted ?? false);
  const persist = vi.fn(async () => opts.grant ?? false);
  return { storage: { persisted, persist }, persist, persisted };
}

describe("StoragePersistence", () => {
  it("check() reads persisted() on load without requesting", async () => {
    const m = manager({ persisted: true });
    const p = new StoragePersistence(m.storage);
    expect(await p.check()).toBe("persisted");
    expect(m.persist).not.toHaveBeenCalled();
  });

  it("granted: model_ready asks once; first_chat_saved then does not ask again", async () => {
    const m = manager({ grant: true });
    const p = new StoragePersistence(m.storage);
    await p.check();
    expect(await p.request("model_ready")).toBe("persisted");
    expect(await p.request("first_chat_saved")).toBe("persisted");
    expect(m.persist).toHaveBeenCalledTimes(1);
  });

  it("denied: asks at most once per trigger, never in a loop", async () => {
    const m = manager({ grant: false });
    const p = new StoragePersistence(m.storage);
    await p.check();
    for (let i = 0; i < 5; i++) await p.request("model_ready");
    expect(m.persist).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) await p.request("first_chat_saved");
    expect(m.persist).toHaveBeenCalledTimes(2);
    expect(p.getState()).toBe("not_persisted");
  });

  it("already persisted on load: never asks", async () => {
    const m = manager({ persisted: true });
    const p = new StoragePersistence(m.storage);
    await p.check();
    await p.request("model_ready");
    await p.request("first_chat_saved");
    expect(m.persist).not.toHaveBeenCalled();
  });

  it("unsupported (no StorageManager methods)", async () => {
    const p = new StoragePersistence({});
    expect(await p.check()).toBe("unsupported");
    expect(await p.request("model_ready")).toBe("unsupported");
    expect(new StoragePersistence(undefined).getState()).toBe("checking");
    expect(await new StoragePersistence(undefined).check()).toBe("unsupported");
  });

  it("a throwing persist() counts as not persisted, and is not retried", async () => {
    const persist = vi.fn(async () => {
      throw new Error("SecurityError");
    });
    const p = new StoragePersistence({ persisted: async () => false, persist });
    await p.check();
    expect(await p.request("model_ready")).toBe("not_persisted");
    await p.request("model_ready");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers on change", async () => {
    const p = new StoragePersistence(manager({ grant: true }).storage);
    const seen: string[] = [];
    p.subscribe(() => seen.push(p.getState()));
    await p.check();
    await p.request("model_ready");
    expect(seen).toEqual(["not_persisted", "persisted"]);
  });
});

describe("first saved chat triggers the request", () => {
  it("the controller reports a saved user message exactly when the write succeeds", async () => {
    const store = await IndexedDBThreadStore.open(new IDBFactory());
    const m = manager({ grant: true });
    const p = new StoragePersistence(m.storage);
    await p.check();
    const c = new PrivateChatController({
      provider: new MockLocalProvider(),
      store,
      profileKey: "anon",
      deviceId: "dev",
      writeClipboard: async () => {},
      onUserMessageSaved: () => void p.request("first_chat_saved"),
    });
    c.setModel(descriptor("M"));
    await c.init();
    await c.send("one");
    await c.send("two");
    await c.send("three");
    expect(m.persist).toHaveBeenCalledTimes(1);
    expect(p.getState()).toBe("persisted");
    store.close();
  });
});

describe("StorageStatus", () => {
  const render = (state: Parameters<typeof StorageStatus>[0]["state"], canExport = true) =>
    renderToStaticMarkup(<StorageStatus state={state} canExport={canExport} onExport={() => {}} />);

  it("persisted → protected, no nudge", () => {
    const html = render("persisted");
    expect(html).toContain(PERSIST_COPY.persisted);
    expect(html).not.toContain(PERSIST_COPY.nudge);
  });

  it.each(["not_persisted", "unsupported"] as const)("%s → may clear + export nudge with button", (state) => {
    const html = render(state);
    expect(html).toContain(PERSIST_COPY.notPersisted);
    expect(html).toContain(PERSIST_COPY.nudge);
    expect(html).toContain("Export this chat");
  });

  it("no active chat → nudge without the button", () => {
    expect(render("not_persisted", false)).not.toContain("Export this chat");
  });

  it("checking → nothing yet", () => {
    expect(render("checking")).toBe("");
  });
});

describe("check/request races", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  function racing() {
    const checked = deferred<boolean>();
    const asked = deferred<boolean>();
    const persist = vi.fn(() => asked.promise);
    const p = new StoragePersistence({ persisted: () => checked.promise, persist });
    return { p, checked, asked, persist };
  }

  it("grant settles first, then a late persisted()===false: stays persisted, no re-ask", async () => {
    const { p, checked, asked, persist } = racing();
    const check = p.check(); // startup, not awaited
    const request = p.request("model_ready");
    asked.resolve(true);
    await request;
    expect(p.getState()).toBe("persisted");
    checked.resolve(false); // stale
    await check;
    expect(p.getState()).toBe("persisted");
    await p.request("first_chat_saved");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("check settles first (false), then the grant: persisted", async () => {
    const { p, checked, asked } = racing();
    const check = p.check();
    const request = p.request("model_ready");
    checked.resolve(false);
    await check;
    expect(p.getState()).toBe("not_persisted");
    asked.resolve(true);
    await request;
    expect(p.getState()).toBe("persisted");
  });

  it("denied request, then a stale check reporting persisted: good news wins", async () => {
    const { p, checked, asked } = racing();
    const check = p.check();
    const request = p.request("model_ready");
    asked.resolve(false);
    await request;
    expect(p.getState()).toBe("not_persisted");
    checked.resolve(true);
    await check;
    expect(p.getState()).toBe("persisted");
  });

  it("check says persisted while a request is pending; a later denial does not downgrade it", async () => {
    const { p, checked, asked } = racing();
    const request = p.request("model_ready");
    const check = p.check();
    checked.resolve(true);
    await check;
    asked.resolve(false);
    await request;
    expect(p.getState()).toBe("persisted");
  });
});
