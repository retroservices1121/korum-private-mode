/**
 * IndexedDB implementation of `ThreadStore`.
 *
 * DB `korum-private`, stores `threads`, `messages` and `meta`. Messages are written incrementally while a reply
 * streams, so a killed tab loses at most the last flush interval of tokens;
 * on the next start `recoverInterrupted()` marks such messages "interrupted".
 *
 * Never sent to a server. Records are stored in plain IndexedDB, protected by
 * the browser's same-origin storage isolation; there is no additional
 * at-rest field encryption.
 */

import {
  type LocalMessage,
  type LocalThread,
  type ProfileKey,
  type ThreadStore,
} from "@/lib/private/core/thread-schema";

export const DB_NAME = "korum-private";
export const DB_VERSION = 1;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

export function openPrivateDB(factory: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("threads")) {
        const threads = db.createObjectStore("threads", { keyPath: "id" });
        threads.createIndex("profileKey", "profileKey");
      }
      if (!db.objectStoreNames.contains("messages")) {
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("threadId", "threadId");
        messages.createIndex("status", "status");
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("korum-private DB upgrade blocked by another tab"));
  });
}

function byCreation(a: LocalMessage, b: LocalMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class IndexedDBThreadStore implements ThreadStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory?: IDBFactory): Promise<IndexedDBThreadStore> {
    return new IndexedDBThreadStore(await openPrivateDB(factory));
  }

  close(): void {
    this.db.close();
  }

  async listThreads(profileKey: ProfileKey): Promise<LocalThread[]> {
    const tx = this.db.transaction("threads", "readonly");
    const rows = await promisify(
      tx.objectStore("threads").index("profileKey").getAll(profileKey) as IDBRequest<LocalThread[]>,
    );
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getThread(id: string): Promise<LocalThread | undefined> {
    const tx = this.db.transaction("threads", "readonly");
    return promisify(tx.objectStore("threads").get(id) as IDBRequest<LocalThread | undefined>);
  }

  async putThread(thread: LocalThread): Promise<void> {
    const tx = this.db.transaction("threads", "readwrite");
    tx.objectStore("threads").put(thread);
    await done(tx);
  }

  async deleteThread(id: string): Promise<void> {
    const tx = this.db.transaction(["threads", "messages"], "readwrite");
    tx.objectStore("threads").delete(id);
    const messages = tx.objectStore("messages");
    const keys = await promisify(messages.index("threadId").getAllKeys(id));
    for (const key of keys) messages.delete(key);
    await done(tx);
  }

  async listMessages(threadId: string): Promise<LocalMessage[]> {
    const tx = this.db.transaction("messages", "readonly");
    const rows = await promisify(
      tx.objectStore("messages").index("threadId").getAll(threadId) as IDBRequest<LocalMessage[]>,
    );
    return rows.sort(byCreation);
  }

  async putMessage(message: LocalMessage): Promise<void> {
    const tx = this.db.transaction("messages", "readwrite");
    tx.objectStore("messages").put(message);
    await done(tx);
  }

  async deleteMessage(id: string): Promise<void> {
    const tx = this.db.transaction("messages", "readwrite");
    tx.objectStore("messages").delete(id);
    await done(tx);
  }

  async recoverInterrupted(): Promise<number> {
    const tx = this.db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    const stale = await promisify(
      store.index("status").getAll("streaming") as IDBRequest<LocalMessage[]>,
    );
    for (const message of stale) {
      store.put({ ...message, status: "interrupted", updatedAt: Date.now() });
    }
    await done(tx);
    return stale.length;
  }

  async getMeta<T = unknown>(key: string): Promise<T | undefined> {
    const tx = this.db.transaction("meta", "readonly");
    const row = await promisify(
      tx.objectStore("meta").get(key) as IDBRequest<{ key: string; value: T } | undefined>,
    );
    return row?.value;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key, value });
    await done(tx);
  }

  async clearProfile(profileKey: ProfileKey): Promise<void> {
    for (const thread of await this.listThreads(profileKey)) await this.deleteThread(thread.id);
  }
}
