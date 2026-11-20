/**
 * Picks the Private Mode engine.
 *
 * Every engine implements `LocalProvider` (`lib/private/core/local-provider.ts`)
 * plus `dispose()`. The factory selects the engine and delegates the device
 * probe to `provider.capability()`. The README describes how to extend
 * model selection for another engine.
 *
 * End-to-end test builds are the one exception: built with
 * `KORUM_E2E_MOCK_PROVIDER=1`, the scripted mock engine replaces everything.
 * `process.env.KORUM_E2E_MOCK_PROVIDER` is replaced at build time with a
 * string literal ("1" or "0") by `env` in `next.config.ts`, so in a normal
 * build the mock branch is `"0" === "1"`, removed by the bundler together with
 * its dynamic import. No runtime input can reach it. Enforced by
 * `tests/private-e2e-mock-inert.test.ts` and checked on real bundles by the
 * Playwright suite.
 */

import type { CapabilityReport, LocalProvider, LocalRuntimeId } from "@/lib/private/core/local-provider";

import { WebLLMLocalProvider } from "./webllm-provider";

export type PrivateEngine = LocalProvider & { dispose(): void };

/** Runtime id → factory. Only runtimes that are actually implemented are listed. */
export const PROVIDERS: Partial<Record<LocalRuntimeId, () => Promise<PrivateEngine>>> = {
  webllm: async () => new WebLLMLocalProvider(),
};

export const DEFAULT_PROVIDER: LocalRuntimeId = "webllm";

export async function createLocalProvider(runtime: LocalRuntimeId = DEFAULT_PROVIDER): Promise<PrivateEngine> {
  if (process.env.KORUM_E2E_MOCK_PROVIDER === "1") {
    const { E2EMockLocalProvider } = await import("./e2e-mock-provider");
    return new E2EMockLocalProvider();
  }
  const create = PROVIDERS[runtime];
  if (!create) throw new Error(`No Private Mode provider registered for ${runtime}`);
  return create();
}

/** The device probe, delegated to the engine so each runtime reports what it needs. */
export function probeFor(provider: PrivateEngine): Promise<CapabilityReport> {
  return provider.capability();
}
