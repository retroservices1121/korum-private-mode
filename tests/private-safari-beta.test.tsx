// @vitest-environment happy-dom
import "fake-indexeddb/auto";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAFARI_BETA_TEXT } from "@/components/private/private-badges";
import { SAFARI_STORAGE_NOTICE } from "@/components/private/model-setup";

import { installNetworkTrap } from "./helpers/network-trap";

/** Private Mode on Safari ships as a labelled beta. */

const flags = vi.hoisted(() => ({ cached: false }));

vi.mock("@/lib/private/web/webllm-provider", async () => {
  const { MockLocalProvider } = await import("./helpers/mock-local-provider");
  const { probeCapability } = await import("@/lib/private/web/capability-probe");
  class WebLLMLocalProvider extends MockLocalProvider {
    onWorkerFailure: (() => void) | null = null;
    // Like the real engine, report what the browser probe sees (UA, GPU).
    async capability() {
      return probeCapability();
    }
    async isCached() {
      return flags.cached;
    }
    dispose() {}
  }
  return { WebLLMLocalProvider };
});

const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const appleGpu = {
  requestAdapter: async () => ({
    features: new Set(["shader-f16"]),
    limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 31 },
    info: { vendor: "apple" },
    isFallbackAdapter: false,
  }),
};

let root: Root | null;
let container: HTMLDivElement;
let trap: ReturnType<typeof installNetworkTrap>;

async function renderApp(ua: string) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
  Object.defineProperty(navigator, "gpu", { configurable: true, value: appleGpu });
  const { PrivateApp } = await import("@/components/private/private-app");
  root = createRoot(container);
  await act(async () => root!.render(<PrivateApp />));
  for (let i = 0; i < 60; i++) {
    const text = container.textContent ?? "";
    if (text.includes("Set up Private Mode") || text.includes("Ask privately") || container.querySelector('textarea[placeholder="Ask privately…"]')) break;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  trap = installNetworkTrap();
  container = document.createElement("div");
  document.body.appendChild(container);
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  trap.restore();
  delete (navigator as unknown as Record<string, unknown>).gpu;
});

describe("Safari beta label", () => {
  it("setup screen on Safari: beta notice next to the 7-day storage notice", async () => {
    flags.cached = false;
    await renderApp(SAFARI_UA);
    const text = container.textContent ?? "";
    expect(text).toContain("Set up Private Mode");
    expect(text).toContain(SAFARI_BETA_TEXT);
    expect(text).toContain(SAFARI_STORAGE_NOTICE);
    expect(container.querySelectorAll('[aria-label="Private Mode on Safari is in beta"]').length).toBeGreaterThan(0);
    expect(trap.requests).toEqual([]);
  });

  it("chat on Safari: beta in the header strip and in the composer chip", async () => {
    flags.cached = true;
    await renderApp(SAFARI_UA);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.disabled).toBe(false);
    expect(container.textContent).toContain(`${SAFARI_BETA_TEXT}.`);
    const chip = [...container.querySelectorAll("span")].find((s) =>
      s.textContent?.startsWith("Private · On this device"),
    )!;
    expect(chip.textContent).toContain("Beta");
    expect(trap.requests).toEqual([]);
  });

  it("no beta label on Chrome", async () => {
    flags.cached = true;
    await renderApp(CHROME_UA);
    expect(container.querySelector("textarea")!.disabled).toBe(false);
    expect(container.textContent).not.toContain(SAFARI_BETA_TEXT);
    expect(container.textContent).not.toMatch(/\bBeta\b/);
  });
});
