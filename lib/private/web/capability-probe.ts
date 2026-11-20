/**
 * Builds a `CapabilityReport` from the browser. Makes no network
 * request: `requestAdapter()` and `storage.estimate()` are local queries.
 */

import type { CapabilityReport } from "@/lib/private/core/local-provider";

import { isSafariUA } from "./browser";

interface NavigatorLike {
  gpu?: { requestAdapter(options?: unknown): Promise<AdapterLike | null> };
  deviceMemory?: number;
  storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> };
  userAgent?: string;
}

interface AdapterLike {
  features: { has(name: string): boolean };
  limits: { maxBufferSize?: number; maxStorageBufferBindingSize?: number };
  info?: { vendor?: string };
  isFallbackAdapter?: boolean;
}

export async function probeCapability(
  nav: NavigatorLike = globalThis.navigator as unknown as NavigatorLike,
): Promise<CapabilityReport> {
  const base: CapabilityReport = {
    runtime: "webllm",
    hasWebGPU: false,
    hasAdapter: false,
    isFallbackAdapter: false,
    shaderF16: false,
    maxBufferSize: null,
    maxStorageBufferBindingSize: null,
    gpuVendor: null,
    deviceMemoryGB: typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null,
    freeStorageBytes: null,
    isSafari: isSafariUA(nav?.userAgent ?? ""),
  };

  try {
    const estimate = await nav?.storage?.estimate?.();
    if (estimate && typeof estimate.quota === "number") {
      base.freeStorageBytes = Math.max(0, estimate.quota - (estimate.usage ?? 0));
    }
  } catch {
    // Unknown storage is not a verdict; the download proves it.
  }

  if (!nav?.gpu) return base;
  base.hasWebGPU = true;

  let adapter: AdapterLike | null = null;
  try {
    adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch {
    adapter = null;
  }
  if (!adapter) return base;

  // `isFallbackAdapter` moved to `adapter.info` in newer specs; read both.
  const info = adapter.info as { vendor?: string; isFallbackAdapter?: boolean } | undefined;
  return {
    ...base,
    hasAdapter: true,
    isFallbackAdapter: Boolean(adapter.isFallbackAdapter ?? info?.isFallbackAdapter),
    shaderF16: adapter.features.has("shader-f16"),
    maxBufferSize: adapter.limits.maxBufferSize ?? null,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize ?? null,
    gpuVendor: info?.vendor ? info.vendor.toLowerCase() : null,
  };
}
