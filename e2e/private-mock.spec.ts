import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { expect, test } from "./support/fixtures";
import type { NetworkGuard } from "./support/network";
import { MOCK_URL } from "./support/urls";

/**
 * Prompt privacy against the production build made with
 * KORUM_E2E_MOCK_PROVIDER=1. The real /private UI, store, controller and
 * renderer run; only the WebLLM engine is replaced by the scripted
 * `E2EMockLocalProvider`, whose answer echoes the prompt's canary into remote,
 * same-origin and data: images, raw `<img>` HTML, inline code and a link.
 *
 * The service worker is blocked here: this build publishes no offline shell
 * (the offline test runs on the normal build).
 */

test.use({ baseURL: MOCK_URL, serviceWorkers: "block" });

interface Violation {
  directive: string;
  blocked: string;
}

declare global {
  interface Window {
    __cspViolations?: Violation[];
  }
}

async function openReady(page: Page) {
  // Collects CSP violations: an image the renderer tried to load would show up here even though
  // the CSP stops it before any request.
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations!.push({ directive: e.effectiveDirective, blocked: e.blockedURI });
    });
  });
  await page.goto("/private");
  await expect(page.locator("#korum-composer")).toBeEnabled();
  await expect(page.locator("#korum-composer")).toHaveAttribute("placeholder", "Ask privately…");
}

async function send(page: Page, text: string, turn: number) {
  await page.locator("#korum-composer").fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(new RegExp(`^Mock answer ${turn} for `))).toBeVisible();
  // Streaming finished: actions appear only on settled messages.
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
}

async function expectNoLeak(guard: NetworkGuard, canary: string) {
  const all = await guard.settle();
  const external = all.filter((r) => r.kind !== "self");
  expect(external, guard.describe(external).join("\n")).toEqual([]);
  const api = all.filter((r) => new URL(r.url).pathname.startsWith("/api/"));
  expect(api, guard.describe(api).join("\n")).toEqual([]);
  const leaked = await guard.containing(canary);
  expect(leaked, guard.describe(leaked).join("\n")).toEqual([]);
  const images = all.filter((r) => r.resourceType === "image" || r.resourceType === "media");
  expect(images, guard.describe(images).join("\n")).toEqual([]);
}

test.describe("Private Mode with the scripted on-device engine", () => {
  test("Markdown canaries render with zero requests; links need confirmation; Cancel does nothing", async ({
    page,
    context,
    guard,
  }) => {
    const canary = `KORUM-CANARY-${randomUUID()}`;
    await openReady(page);
    const before = (await guard.settle()).length;

    await send(page, `Render this ${canary}`, 1);
    await page.waitForTimeout(1_500);
    const answer = page.locator(".korum-prose").last();

    // No element that could fetch anything, and no image with a source anywhere.
    const fetchers = await page.evaluate(() =>
      document.querySelectorAll("img, picture, source, video, audio, iframe, object, embed, link[rel=prefetch]").length,
    );
    expect(fetchers).toBe(0);
    await expect(page.locator("img[src], [srcset]")).toHaveCount(0);

    // Remote, same-origin and data: images all become text placeholders.
    const placeholders = answer.locator("[data-private-image-placeholder]");
    await expect(placeholders).toHaveCount(3);
    await expect(placeholders.nth(0)).toContainText(`https://canary.test/img?c=${canary}`);
    await expect(placeholders.nth(1)).toContainText(`/canary-same-origin?c=${canary}`);
    // react-markdown's URL filter already empties `data:` sources; the placeholder keeps the alt text.
    await expect(placeholders.nth(2)).toHaveText("Image not loaded in Private Mode: inline");
    expect(await answer.innerHTML()).not.toContain("data:image");

    // Raw HTML is never rendered as an element; HTML in code shows as text.
    expect(await answer.innerHTML()).not.toContain("canary.test/raw");
    await expect(answer.locator("code")).toContainText(`<img src="https://canary.test/code?c=${canary}">`);

    // The link has no live href; activating it opens the confirm dialog; Cancel does nothing.
    const link = answer.locator("a[data-private-href]");
    await expect(link).toHaveCount(1);
    expect(await link.getAttribute("href")).toBeNull();
    const url = page.url();
    const pages = context.pages().length;
    await link.click();
    const dialog = page.getByRole("dialog", { name: "Open a website outside Private Mode?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`https://canary.test/link?c=${canary}`);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(1_000);
    expect(page.url()).toBe(url);
    expect(context.pages().length).toBe(pages);

    const violations = await page.evaluate(() => window.__cspViolations ?? []);
    const fromAnswer = violations.filter(
      (v) => v.blocked.includes("canary.test") || v.blocked.includes("/canary-same-origin") || v.blocked.startsWith("data"),
    );
    expect(fromAnswer).toEqual([]);

    const afterRender = (await guard.settle()).slice(before);
    // Rendering, dialog and cancel: not a single request of any kind.
    expect(afterRender, guard.describe(afterRender).join("\n")).toEqual([]);
    await expectNoLeak(guard, canary);
  });

  test("copy, thumbs and regenerate are local only", async ({ page, guard, browserName, context }) => {
    if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const canary = `KORUM-CANARY-${randomUUID()}`;
    await openReady(page);
    await send(page, `Actions ${canary}`, 1);
    const before = (await guard.settle()).length;

    await page.getByRole("button", { name: "Copy" }).first().click();
    if (browserName === "chromium") {
      await expect(page.getByRole("button", { name: "Copied" }).first()).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`Mock answer 1 for ${canary}`);
    }
    const up = page.getByRole("button", { name: "Helpful", exact: true });
    await up.click();
    await expect(up).toHaveAttribute("aria-pressed", "true");
    const down = page.getByRole("button", { name: "Not helpful" });
    await down.click();
    await expect(down).toHaveAttribute("aria-pressed", "true");
    await expect(up).toHaveAttribute("aria-pressed", "false");

    await page.getByRole("button", { name: "Regenerate" }).click();
    await expect(page.getByText(/^Mock answer 2 for /)).toBeVisible();
    await expect(page.getByText(/^Mock answer 1 for /)).toHaveCount(0);
    await page.waitForTimeout(1_000);

    const during = (await guard.settle()).slice(before);
    expect(during, guard.describe(during).join("\n")).toEqual([]);
    await expectNoLeak(guard, canary);
  });

  test("a prompt canary sent 20 times never appears in any request; history survives a reload", async ({
    page,
    guard,
  }) => {
    test.setTimeout(180_000);
    const canary = `KORUM-CANARY-${randomUUID()}`;
    await openReady(page);
    for (let turn = 1; turn <= 20; turn++) await send(page, `Turn ${turn}: ${canary}`, turn);
    const userTurns = page.locator("main").getByText(new RegExp(`^Turn \\d+: ${canary}$`));
    await expect(userTurns).toHaveCount(20);

    await page.reload();
    await expect(page.locator("#korum-composer")).toBeEnabled();
    await page
      .getByRole("navigation", { name: "Private chats" })
      .getByRole("button", { name: `Turn 1: ${canary}`, exact: true })
      .click();
    await expect(userTurns).toHaveCount(20);
    await expect(page.locator("main").getByText(/^Mock answer \d+ for /)).toHaveCount(20);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2_000);

    await expectNoLeak(guard, canary);
    // The bundle loaded here contains the mock engine (positive control for csp-offline.spec.ts).
    const scripts = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.endsWith(".js")),
    );
    let hasMarker = false;
    for (const src of scripts) {
      if ((await (await page.request.get(src)).text()).includes("korum-e2e-mock-provider")) hasMarker = true;
    }
    expect(hasMarker).toBe(true);
  });
});
