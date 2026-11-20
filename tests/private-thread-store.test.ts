import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION, ulid, type LocalMessage, type LocalThread } from "@/lib/private/core/thread-schema";
import { IndexedDBThreadStore, openPrivateDB } from "@/lib/private/web/thread-store";

function thread(overrides: Partial<LocalThread> = {}): LocalThread {
  const at = overrides.createdAt ?? 1000;
  return {
    id: ulid(at),
    schemaVersion: SCHEMA_VERSION,
    profileKey: "anon",
    deviceId: "dev",
    title: "A thread",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function message(threadId: string, overrides: Partial<LocalMessage> = {}): LocalMessage {
  const at = overrides.createdAt ?? 1000;
  return {
    id: ulid(at),
    threadId,
    schemaVersion: SCHEMA_VERSION,
    deviceId: "dev",
    role: "user",
    content: "hi",
    origin: "local",
    status: "complete",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

let factory: IDBFactory;
let store: IndexedDBThreadStore;

beforeEach(async () => {
  factory = new IDBFactory();
  store = await IndexedDBThreadStore.open(factory);
});
afterEach(() => store.close());

describe("IndexedDB thread store", () => {
  it("creates DB korum-private with threads/messages/meta stores", async () => {
    const db = await openPrivateDB(factory);
    expect(db.name).toBe("korum-private");
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames].sort()).toEqual(["messages", "meta", "threads"]);
    db.close();
  });

  it("thread CRUD, newest first", async () => {
    const a = thread({ title: "old", createdAt: 1, updatedAt: 1 });
    const b = thread({ title: "new", createdAt: 2, updatedAt: 5 });
    await store.putThread(a);
    await store.putThread(b);

    expect((await store.listThreads("anon")).map((t) => t.title)).toEqual(["new", "old"]);
    expect(await store.getThread(a.id)).toEqual(a);

    await store.putThread({ ...a, title: "renamed", updatedAt: 10 });
    expect((await store.listThreads("anon"))[0].title).toBe("renamed");

    await store.deleteThread(a.id);
    expect(await store.getThread(a.id)).toBeUndefined();
  });

  it("message CRUD in creation order; deleting a thread deletes its messages", async () => {
    const t = thread();
    await store.putThread(t);
    const later = message(t.id, { createdAt: 20, role: "assistant", content: "answer" });
    const earlier = message(t.id, { createdAt: 10, content: "question" });
    await store.putMessage(later);
    await store.putMessage(earlier);
    expect((await store.listMessages(t.id)).map((m) => m.content)).toEqual(["question", "answer"]);

    // Incremental writes during streaming overwrite the same record.
    await store.putMessage({ ...later, content: "answer, longer", updatedAt: 21 });
    expect((await store.listMessages(t.id))[1].content).toBe("answer, longer");

    await store.deleteMessage(earlier.id);
    expect(await store.listMessages(t.id)).toHaveLength(1);

    await store.deleteThread(t.id);
    expect(await store.listMessages(t.id)).toEqual([]);
  });

  it("marks messages left streaming by a killed tab as interrupted", async () => {
    const t = thread();
    await store.putThread(t);
    const streaming = message(t.id, { role: "assistant", content: "half an ans", status: "streaming" });
    const done = message(t.id, { createdAt: 900, status: "complete" });
    await store.putMessage(streaming);
    await store.putMessage(done);

    // A new tab opens the same DB after the old one died mid-stream.
    store.close();
    store = await IndexedDBThreadStore.open(factory);
    expect(await store.recoverInterrupted()).toBe(1);

    const messages = await store.listMessages(t.id);
    expect(messages.find((m) => m.id === streaming.id)?.status).toBe("interrupted");
    expect(messages.find((m) => m.id === streaming.id)?.content).toBe("half an ans");
    expect(messages.find((m) => m.id === done.id)?.status).toBe("complete");
    expect(await store.recoverInterrupted()).toBe(0);
  });

  it("meta and clearProfile", async () => {
    await store.setMeta("initializedAt", 123);
    expect(await store.getMeta<number>("initializedAt")).toBe(123);
    expect(await store.getMeta("missing")).toBeUndefined();

    const mine = thread();
    await store.putThread(mine);
    await store.putMessage(message(mine.id));
    await store.clearProfile("anon");
    expect(await store.listThreads("anon")).toEqual([]);
    expect(await store.listMessages(mine.id)).toEqual([]);
  });
});

describe("ulid", () => {
  it("is 26 Crockford chars and sorts by time", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});
