import { vi } from "vitest";

/**
 * Replaces every browser network primitive with a recorder that fails the
 * request. A Private Mode test passes only if `requests` stays empty.
 */
export interface TrappedRequest {
  api: "fetch" | "XMLHttpRequest" | "sendBeacon" | "WebSocket" | "EventSource" | "Image";
  url: string;
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) return String((input as { url: unknown }).url);
  return String(input);
}

export function installNetworkTrap() {
  const requests: TrappedRequest[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const swap = (key: string, value: unknown) => {
    saved.set(key, g[key]);
    g[key] = value;
  };

  swap(
    "fetch",
    vi.fn(async (input: unknown) => {
      requests.push({ api: "fetch", url: urlOf(input) });
      throw new TypeError("network disabled in Private Mode test");
    }),
  );

  class TrapXHR {
    open(_method: string, url: string) {
      requests.push({ api: "XMLHttpRequest", url: urlOf(url) });
    }
    send() {}
    setRequestHeader() {}
    abort() {}
    addEventListener() {}
  }
  swap("XMLHttpRequest", TrapXHR);

  class TrapWebSocket {
    constructor(url: unknown) {
      requests.push({ api: "WebSocket", url: urlOf(url) });
    }
    close() {}
    send() {}
    addEventListener() {}
  }
  swap("WebSocket", TrapWebSocket);

  class TrapEventSource {
    constructor(url: unknown) {
      requests.push({ api: "EventSource", url: urlOf(url) });
    }
    close() {}
    addEventListener() {}
  }
  swap("EventSource", TrapEventSource);

  const nav = (g.navigator ?? {}) as Record<string, unknown>;
  const savedBeacon = Object.getOwnPropertyDescriptor(nav, "sendBeacon");
  Object.defineProperty(nav, "sendBeacon", {
    configurable: true,
    value: (url: unknown) => {
      requests.push({ api: "sendBeacon", url: urlOf(url) });
      return false;
    },
  });

  return {
    requests,
    restore() {
      for (const [key, value] of saved) g[key] = value;
      if (savedBeacon) Object.defineProperty(nav, "sendBeacon", savedBeacon);
      else delete nav.sendBeacon;
    },
  };
}
