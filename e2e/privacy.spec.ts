import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { expect, quietPeriod, test, UNAVAILABLE_HEADLINE } from "./support/fixtures";
import type { NetworkGuard } from "./support/network";

/**
 * Privacy on the normal production build, headless and without a GPU:
 * /private shows the unavailable state and the page sends nothing to any
 * other origin, and nothing to a server API on its own origin.
 */

async function expectPrivateShell(page: Page) {
  await expect(page.getByRole("heading", { name: UNAVAILABLE_HEADLINE })).toBeVisible();
  await expect(page.locator("#korum-composer")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(page.getByText("Private chats · this device", { exact: false })).toBeVisible();
}

async function expectSilence(guard: NetworkGuard) {
  const all = await guard.settle();
  const external = all.filter((r) => r.kind !== "self");
  expect(external, guard.describe(external).join("\n")).toEqual([]);
  const api = all.filter((r) => new URL(r.url).pathname.startsWith("/api/"));
  expect(api, guard.describe(api).join("\n")).toEqual([]);
}

test.describe("Private Mode privacy (normal production build)", () => {
  test("direct load of /private: unavailable state, composer disabled, zero third-party or API traffic", async ({
    page,
    guard,
  }) => {
    await page.goto("/private");
    await expectPrivateShell(page);
    await quietPeriod(page);
    await expectSilence(guard);
  });

  test("/ redirects to /private, and the private document sends nothing", async ({ page, guard }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/private$/);
    await expectPrivateShell(page);
    await quietPeriod(page);
    await expectSilence(guard);
  });

  test("text in the page and errors thrown on /private never leave the browser", async ({ page, guard }) => {
    await page.goto("/private");
    await expectPrivateShell(page);

    const typed = `KORUM-CANARY-${randomUUID()}`;
    await page.locator("#korum-composer").evaluate((el, text) => {
      // The composer is disabled here; put the canary in the DOM anyway, as a page would hold it.
      (el as HTMLTextAreaElement).value = text;
    }, typed);

    const secret = `KORUM-CANARY-error-${randomUUID()}`;
    await page.evaluate((m) => {
      setTimeout(() => {
        throw new Error(m);
      });
      void Promise.reject(new Error(`${m}-rejection`));
    }, secret);
    await quietPeriod(page);

    for (const needle of [typed, secret]) {
      const leaked = await guard.containing(needle);
      expect(leaked, guard.describe(leaked).join("\n")).toEqual([]);
    }
    await expectSilence(guard);
  });
});
