import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The e2e mock engine (`lib/private/web/e2e-mock-provider.ts`) must be
 * unreachable in every normal build. It is selected only by the build-time
 * constant `process.env.KORUM_E2E_MOCK_PROVIDER`, which `next.config.ts`
 * always inlines as "0" unless the build ran with exactly
 * KORUM_E2E_MOCK_PROVIDER=1 (and its own distDir, never for a deploy build). The
 * Playwright suite also checks that served normal bundles do not contain it.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const GUARD = 'process.env.KORUM_E2E_MOCK_PROVIDER === "1"';

async function sources(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of glob("{app,components,lib}/**/*.{ts,tsx,js,mjs}", { cwd: ROOT })) out.push(entry);
  return out;
}

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("e2e mock engine is inert unless built for e2e", () => {
  it("only provider-factory loads it, by a dynamic import behind the build constant", async () => {
    const importers = [];
    for (const file of await sources()) {
      if (file.endsWith("e2e-mock-provider.ts")) continue;
      if (read(file).includes("e2e-mock-provider")) importers.push(file);
    }
    expect(importers).toEqual(["lib/private/web/provider-factory.ts"]);

    const factory = stripComments(read("lib/private/web/provider-factory.ts"));
    expect(factory).not.toMatch(/^import[^;]*e2e-mock-provider/m);
    const guarded = new RegExp(
      `if \\(${GUARD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) \\{\\s*const \\{ E2EMockLocalProvider \\} = await import\\("\\./e2e-mock-provider"\\);`,
    );
    expect(factory).toMatch(guarded);
  });

  it("the flag is read only as the exact build-time comparison, never from runtime input", async () => {
    for (const file of await sources()) {
      const code = stripComments(read(file));
      const uses = code.match(/[^\n]*KORUM_E2E_MOCK_PROVIDER[^\n]*/g) ?? [];
      for (const line of uses) expect(line, file).toContain(GUARD);
    }
    const factory = stripComments(read("lib/private/web/provider-factory.ts"));
    expect(factory).not.toMatch(/window|location|localStorage|sessionStorage|URLSearchParams|document\./);
  });

  it("creates the real WebLLM provider when the flag is unset", async () => {
    vi.stubEnv("KORUM_E2E_MOCK_PROVIDER", "");
    const { createLocalProvider } = await import("@/lib/private/web/provider-factory");
    const { WebLLMLocalProvider } = await import("@/lib/private/web/webllm-provider");
    const provider = await createLocalProvider();
    expect(provider).toBeInstanceOf(WebLLMLocalProvider);
    provider.dispose();
  });

  it("next.config inlines \"0\" unless the value is exactly 1", async () => {
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      vi.resetModules();
      vi.stubEnv("KORUM_E2E_MOCK_PROVIDER", value);
      vi.stubEnv("KORUM_E2E_DIST_DIR", ".next-ignored");
      const config = (await import("../next.config")).default;
      expect(config.env?.KORUM_E2E_MOCK_PROVIDER, String(value)).toBe("0");
      expect(config.distDir).toBe(".next");
      expect(config.typescript).toBeUndefined();
    }
  });

  it("a mock build needs its own distDir and is refused for deploy builds", async () => {
    vi.stubEnv("KORUM_E2E_MOCK_PROVIDER", "1");
    vi.stubEnv("KORUM_E2E_DIST_DIR", "");
    await expect(import("../next.config")).rejects.toThrow(/KORUM_E2E_DIST_DIR/);

    vi.resetModules();
    vi.stubEnv("KORUM_E2E_DIST_DIR", ".next-e2e-mock");
    vi.stubEnv("KORUM_DEPLOY", "1");
    await expect(import("../next.config")).rejects.toThrow(/deploy builds/);

    vi.resetModules();
    vi.stubEnv("KORUM_DEPLOY", "");
    const config = (await import("../next.config")).default;
    expect(config.env?.KORUM_E2E_MOCK_PROVIDER).toBe("1");
    expect(config.distDir).toBe(".next-e2e-mock");
  });

  it("the postbuild never publishes an offline shell from a mock build", async () => {
    vi.stubEnv("KORUM_E2E_MOCK_PROVIDER", "1");
    const { buildPrivateOffline } = await import("../scripts/build-private-offline.mjs");
    await expect(buildPrivateOffline("/nonexistent")).rejects.toThrow(/e2e mock build/);
  });
});
