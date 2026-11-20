/**
 * Logical schema for private chats. Portable core.
 *
 * Threads and messages are stored in IndexedDB (`lib/private/web/thread-store.ts`).
 *
 * Nothing here is ever sent to a server.
 */

export const SCHEMA_VERSION = 1;

/** Key used by the IndexedDB thread index. */
export type ProfileKey = "anon";

export interface LocalThread {
  id: string;
  schemaVersion: number;
  profileKey: ProfileKey;
  deviceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export type LocalMessageStatus = "streaming" | "complete" | "interrupted" | "error";

export interface LocalMessage {
  id: string;
  threadId: string;
  schemaVersion: number;
  deviceId: string;
  role: "user" | "assistant";
  content: string;
  /** Where the message was produced. Always "local": every answer comes from this device. */
  origin: "local";
  /** Logical catalog id of the model that wrote an assistant turn. */
  localModel?: string;
  status: LocalMessageStatus;
  /** Local-only feedback. Never leaves the device. */
  thumb?: "up" | "down" | null;
  /** Content-free reason for status "error", e.g. "context_exceeded". */
  errorKind?: string;
  createdAt: number;
  updatedAt: number;
}

/** Local chat and metadata storage contract. */
export interface ThreadStore {
  listThreads(profileKey: ProfileKey): Promise<LocalThread[]>;
  getThread(id: string): Promise<LocalThread | undefined>;
  putThread(thread: LocalThread): Promise<void>;
  deleteThread(id: string): Promise<void>;
  listMessages(threadId: string): Promise<LocalMessage[]>;
  putMessage(message: LocalMessage): Promise<void>;
  deleteMessage(id: string): Promise<void>;
  /** Marks any message left "streaming" (tab killed mid-answer) as "interrupted". */
  recoverInterrupted(): Promise<number>;
  getMeta<T = unknown>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  /** Removes every private chat on this device for this profile. */
  clearProfile(profileKey: ProfileKey): Promise<void>;
}

// ---------------------------------------------------------------- ULID ids

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type RandomSource = (bytes: Uint8Array) => Uint8Array;

const defaultRandom: RandomSource = (bytes) => globalThis.crypto.getRandomValues(bytes);

/**
 * Lexicographically sortable id (ULID) with a 48-bit timestamp and 80 random bits.
 */
export function ulid(now: number = Date.now(), random: RandomSource = defaultRandom): string {
  let time = "";
  let t = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(new Uint8Array(16));
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return time + rand;
}

export function compareById(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
