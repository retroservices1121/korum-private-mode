/**
 * Creates the Private Mode engines.
 *
 * `createBuiltinProvider()`: the browser's built-in model (Prompt API), only
 * for a vendor `detectBuiltin()` verified (Chrome or Edge). Always the real
 * adapter, in every build; the e2e suite exercises it with a fake
 * `LanguageModel` installed by a test init script.
 *
 * `createLocalProvider()`: the WebLLM engine (the opt-in upgrade tiers). Always WebLLM, except in a build made for the
 * end-to-end suite with `KORUM_E2E_MOCK_PROVIDER=1`.
 *
 * `process.env.KORUM_E2E_MOCK_PROVIDER` is replaced at build time with a
 * string literal ("1" or "0") by `env` in `next.config.ts`, so in a normal
 * build the mock branch is `"0" === "1"`, removed by the bundler together with
 * its dynamic import. No runtime input can reach it. Enforced by
 * `tests/private-e2e-mock-inert.test.ts` and checked on real bundles by the
 * Playwright suite.
 */

import type { CapabilityReport, LocalProvider } from "@/lib/private/core/local-provider";
import type { BuiltinVendor } from "@/lib/private/core/provider-policy";

import { probeCapability } from "./capability-probe";
import { BuiltinPromptApiProvider } from "./prompt-api";
import { WebLLMLocalProvider } from "./webllm-provider";

export type PrivateEngine = LocalProvider & { dispose(): void };

export async function createLocalProvider(): Promise<PrivateEngine> {
  if (process.env.KORUM_E2E_MOCK_PROVIDER === "1") {
    const { E2EMockLocalProvider } = await import("./e2e-mock-provider");
    return new E2EMockLocalProvider();
  }
  return new WebLLMLocalProvider();
}

/** The device probe; the e2e mock engine reports its own (fake) capable device. */
export function probeFor(provider: PrivateEngine): Promise<CapabilityReport> {
  if (process.env.KORUM_E2E_MOCK_PROVIDER === "1") return provider.capability();
  return probeCapability();
}

export function createBuiltinProvider(vendor: BuiltinVendor): BuiltinPromptApiProvider {
  return new BuiltinPromptApiProvider(vendor);
}
