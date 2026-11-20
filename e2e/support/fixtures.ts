import { test as base, expect } from "@playwright/test";

import { installNetworkGuard, type NetworkGuard } from "./network";

/**
 * Every test gets a context whose network is guarded before any page opens:
 * all requests are recorded, non-self requests are answered locally.
 */
export const test = base.extend<{ guard: NetworkGuard; selfOrigin: string }>({
  selfOrigin: async ({ baseURL }, use) => {
    if (!baseURL) throw new Error("baseURL is required");
    await use(new URL(baseURL).origin);
  },
  guard: [
    async ({ context, selfOrigin }, use) => {
      // Many third-party scripts go quiet under automation (`navigator.webdriver`,
      // HeadlessChrome brands). Look like a normal browser, so silence on /private means
      // something. Test-side only.
      await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
        Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
      });
      await use(await installNetworkGuard(context, selfOrigin));
    },
    { auto: true },
  ],
});

export { expect };

export const UNAVAILABLE_HEADLINE = "Private Mode isn't available in this browser on this device.";

/** Lets any delayed, batched request happen before asserting silence. */
export async function quietPeriod(page: import("@playwright/test").Page, ms = 5_000) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(ms);
}
