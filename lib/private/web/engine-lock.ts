/**
 * One engine per browser profile. A second tab must not load a
 * second multi-GB model, so the tab that holds the Web Lock owns the engine
 * and every other tab shows "Private Mode is open in another tab."
 */

export const ENGINE_LOCK_NAME = "korum-private-engine";

export interface EngineLock {
  release(): void;
}

interface LocksLike {
  request(
    name: string,
    options: { ifAvailable: boolean; mode?: "exclusive" },
    callback: (lock: unknown | null) => Promise<void> | void,
  ): Promise<unknown>;
}

/**
 * Resolves with a held lock, or `null` when another tab holds it. Browsers
 * without `navigator.locks` (very old) are allowed through: the lock is a
 * resource guard, not a privacy control.
 */
export function acquireEngineLock(
  locks: LocksLike | undefined = (globalThis.navigator as unknown as { locks?: LocksLike })?.locks,
): Promise<EngineLock | null> {
  if (!locks) return Promise.resolve({ release() {} });

  return new Promise((resolve) => {
    let release: () => void = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    void locks
      .request(ENGINE_LOCK_NAME, { ifAvailable: true, mode: "exclusive" }, (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        resolve({ release });
        return held; // held until release() or the tab closes
      })
      .catch(() => resolve(null));
  });
}
