import { randomUUID } from "node:crypto";

import { installFakeLanguageModel } from "./support/fake-language-model";
import { expect, test, UNAVAILABLE_HEADLINE } from "./support/fixtures";

/**
 * The browser's built-in model on the NORMAL production build (no mock
 * engine in the bundle). A test init script installs a fake `LanguageModel`
 * and Chrome brands; everything else is the shipped code: detection, the
 * Prompt API provider on the main thread, the UI and the store.
 *
 * Plain headless Chromium itself exposes a real `LanguageModel` (it reports
 * "downloadable") with a Chrome-like UA but, under the shared fixture, no
 * `userAgentData` (the fixture hides it to exercise main-shell telemetry); the other specs rely on that being refused as
 * unverified. The fake here replaces it and adds Chrome brands.
 *
 * Proves: it is the default, a browser download needs a click and shows
 * progress, a chat sends nothing anywhere (no foreign origin, no /api, the
 * canary in no request), and a browser whose built-in model can't be
 * verified as on-device is never used.
 */

async function waitForOfflineShell(page: import("@playwright/test").Page) {
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/private");
    return registration?.active?.state;
  }), { timeout: 60_000 }).toBe("activated");
}

test.describe("Private Mode on the browser's built-in model (normal build)", () => {
  test("available: chat on Gemini Nano with zero requests carrying the prompt", async ({ page, guard }) => {
    await installFakeLanguageModel(page, { availability: "available", brand: "Google Chrome" });
    await page.goto("/private");
    const composer = page.locator("#korum-composer");
    await expect(composer).toBeEnabled();
    await expect(page.locator("[data-provider-bar]")).toContainText("On this device: Gemini Nano (built into Chrome)");
    await expect(page.locator('[data-privacy-copy="builtin"]')).toContainText(
      "No data is sent to Google or any third party when using the model.",
    );
    // Headless has no WebGPU, so no upgrade is offered, and nothing is downloaded.
    await expect(page.getByRole("button", { name: /Better quality/ })).toHaveCount(0);
    await expect(page.getByText("Set up Private Mode")).toHaveCount(0);
    await waitForOfflineShell(page);
    await page.waitForLoadState("networkidle");
    const before = (await guard.settle()).length;

    const canary = `KORUM-CANARY-${randomUUID()}`;
    await composer.fill(`Hello ${canary}`);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(new RegExp(`^Mock answer 1 for ${canary}`))).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
    await page.waitForTimeout(1_500);

    const all = await guard.settle();
    const during = all.slice(before);
    expect(during, guard.describe(during).join("\n")).toEqual([]);
    const external = all.filter((r) => r.kind !== "self");
    expect(external, guard.describe(external).join("\n")).toEqual([]);
    const api = all.filter((r) => new URL(r.url).pathname.startsWith("/api/"));
    expect(api, guard.describe(api).join("\n")).toEqual([]);
    expect(await guard.containing(canary)).toEqual([]);
    // The built-in path never started the WebLLM worker or touched R2.
    expect(all.filter((r) => r.kind === "r2")).toEqual([]);
    const stats = await page.evaluate(() => window.__fakeLM);
    expect(stats?.prompts).toBe(1);
  });

  test("evicted upgrade: the offline shell installs, then built-in Enable and chat make zero requests", async ({
    page, guard, request, selfOrigin, browserName,
  }) => {
    await installFakeLanguageModel(page, {
      availability: "downloadable",
      brand: "Google Chrome",
      progress: [0, 0.3, 0.6, 1],
      progressDelayMs: 400,
    });
    await page.addInitScript(() => {
      localStorage.setItem("korum-private-prefs", JSON.stringify({
        deviceId: "returning-device", provider: "webllm", choice: "XS",
      }));
      Object.defineProperty(navigator.storage, "estimate", {
        value: async () => ({ quota: 64 * 2 ** 30, usage: 0 }),
      });
      Object.defineProperty(navigator, "gpu", {
        value: {
          requestAdapter: async () => ({
            features: new Set(["shader-f16"]),
            limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 31 },
            info: { vendor: "nvidia" },
          }),
        },
      });
      let workers = 0;
      window.Worker = new Proxy(window.Worker, {
        construct(target, args) {
          document.documentElement.setAttribute("data-test-worker-count", String(++workers));
          return Reflect.construct(target, args);
        },
      });
      const match = CacheStorage.prototype.match;
      CacheStorage.prototype.match = function (key, options) {
        if (options?.cacheName?.startsWith("webllm/")) {
          document.documentElement.setAttribute("data-test-webllm-cache-checked", "true");
        }
        return match.call(this, key, options);
      };
    });
    const sw = await (await request.get("/private-sw.js")).text();
    const manifest = JSON.parse(/const MANIFEST = (\{.*?\});\n/.exec(sw)![1]) as {
      assets: string[];
      shell: string;
      rsc: string;
    };
    const shellPaths = new Set(["/private", "/private-sw.js", manifest.shell, manifest.rsc, ...manifest.assets]);
    await page.goto("/private");
    const enable = page.getByRole("button", { name: "Enable — Chrome downloads it once" });
    await expect(enable).toBeVisible();
    await expect(page.locator("#korum-composer")).toBeDisabled();
    expect((await page.evaluate(() => window.__fakeLM))?.createCalls).toBe(0);

    await expect(page.locator("html")).toHaveAttribute("data-test-webllm-cache-checked", "true");
    await waitForOfflineShell(page);
    await page.waitForLoadState("networkidle");
    const startup = await guard.settle();
    const unexpected = startup.filter(({ url }) => {
      const parsed = new URL(url);
      return parsed.origin !== selfOrigin || !shellPaths.has(parsed.pathname);
    });
    expect(unexpected, guard.describe(unexpected).join("\n")).toEqual([]);
    if (browserName === "chromium") {
      expect(startup.some((r) => r.fromServiceWorker && new URL(r.url).pathname === manifest.shell)).toBe(true);
    }

    await enable.click();
    await expect(page.getByText(/Chrome is downloading Gemini Nano… (30|60)%/)).toBeVisible();
    await expect(page.locator("#korum-composer")).toBeEnabled();
    const stats = await page.evaluate(() => window.__fakeLM);
    expect(stats?.createCalls).toBe(1);
    expect(stats?.userActivation).toEqual([true]);

    const canary = `KORUM-CANARY-${randomUUID()}`;
    await page.locator("#korum-composer").fill(canary);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(new RegExp(`^Mock answer 1 for ${canary}`))).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
    await page.waitForTimeout(1_500);

    const during = (await guard.settle()).slice(startup.length);
    expect(during, guard.describe(during).join("\n")).toEqual([]);
    await expect(page.locator("html")).not.toHaveAttribute("data-test-worker-count", /.+/);
  });

  test("a browser that isn't Chrome or Edge: its built-in model is not used", async ({ page, guard }) => {
    await installFakeLanguageModel(page, { availability: "available", brand: "Opera" });
    await page.goto("/private");
    // Headless, no GPU: no downloadable model either, so the hard stop explains both.
    await expect(page.getByRole("heading", { name: UNAVAILABLE_HEADLINE })).toBeVisible();
    await expect(page.locator('[data-unavailable="builtin"]')).toContainText(
      "can't verify that it runs on this device",
    );
    await expect(page.locator("#korum-composer")).toBeDisabled();
    const stats = await page.evaluate(() => window.__fakeLM);
    expect(stats).toMatchObject({ availabilityCalls: 0, createCalls: 0 });
    const external = (await guard.settle()).filter((r) => r.kind !== "self");
    expect(external, guard.describe(external).join("\n")).toEqual([]);
  });
});
