// @vitest-environment happy-dom
import "fake-indexeddb/auto";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pickTier } from "@/lib/private/core/tier-policy";
import { probeCapability } from "@/lib/private/web/capability-probe";

import { installNetworkTrap } from "./helpers/network-trap";

/**
 * Without usable WebGPU, Private Mode shows the hard stop, the composer is
 * disabled, and nothing goes to the network — never a silent remote fallback.
 */

type GpuCase = { name: string; gpu: unknown; reason: string };

const adapter = (overrides: Record<string, unknown> = {}) => ({
  features: new Set<string>(["shader-f16"]),
  limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 31 },
  info: { vendor: "nvidia" },
  isFallbackAdapter: false,
  ...overrides,
});

const CASES: GpuCase[] = [
  { name: "navigator.gpu undefined", gpu: undefined, reason: "no_webgpu" },
  { name: "requestAdapter() → null", gpu: { requestAdapter: async () => null }, reason: "no_adapter" },
  {
    name: "isFallbackAdapter",
    gpu: { requestAdapter: async () => adapter({ isFallbackAdapter: true }) },
    reason: "fallback_adapter",
  },
  {
    name: "isFallbackAdapter reported on adapter.info",
    gpu: {
      requestAdapter: async () =>
        adapter({ isFallbackAdapter: undefined, info: { vendor: "google", isFallbackAdapter: true } }),
    },
    reason: "fallback_adapter",
  },
];

function setGpu(gpu: unknown) {
  Object.defineProperty(navigator, "gpu", { configurable: true, value: gpu });
}

describe.each(CASES)("no usable WebGPU: $name", ({ gpu, reason }) => {
  let trap: ReturnType<typeof installNetworkTrap>;
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    trap = installNetworkTrap();
    setGpu(gpu);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
    trap.restore();
    delete (navigator as unknown as Record<string, unknown>).gpu;
    localStorage.clear();
  });

  it("probe + pickTier say unavailable", async () => {
    const report = await probeCapability();
    const decision = pickTier(report, { choice: "auto", failures: {}, now: Date.now() });
    expect(decision).toEqual({ status: "unavailable", reason });
    expect(trap.requests).toEqual([]);
  });

  it("the private app shows the hard stop, disables the composer, and stays offline", async () => {
    const { PrivateApp } = await import("@/components/private/private-app");
    root = createRoot(container);
    await act(async () => root!.render(<PrivateApp />));

    for (let i = 0; i < 50 && !container.textContent?.includes("isn't available"); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }

    expect(container.textContent).toContain(
      "Private Mode isn't available in this browser on this device.",
    );
    expect(container.textContent).toContain("Safari 26 on macOS");

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea!.disabled).toBe(true);
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    expect(send?.disabled).toBe(true);

    // Typing and pressing Enter in the disabled composer still sends nothing.
    await act(async () => {
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    // No link offers a way out to another service: the hard stop is final.
    expect(container.querySelectorAll("a[href]")).toHaveLength(0);

    expect(trap.requests).toEqual([]);
  });
});
