import type { APIResponse, Page, Response } from "@playwright/test";

import { privateHeaders } from "../lib/private/core/private-headers.mjs";
import { expect, test, UNAVAILABLE_HEADLINE } from "./support/fixtures";
import { R2_ORIGIN } from "./support/network";

/**
 * Private Mode CSP, cold offline reload, and the e2e-mock hook's absence from normal bundles. CSP and offline run on
 * Chromium and WebKit. Playwright reports service-worker-originated requests
 * only on Chromium; on WebKit the offline test still proves the page loads
 * came from the worker (`response.fromServiceWorker()`).
 */

const EXPECTED = privateHeaders(R2_ORIGIN, false);

function expectPrivateHeaders(headers: Record<string, string>) {
  for (const { key, value } of EXPECTED) expect(headers[key.toLowerCase()], key).toBe(value);
}

/**
 * Public access: /private, /private-offline/*, and /private-sw.js must be
 * served directly (no redirect, no cookies) to a clean context.
 */
test.describe("Public access to Private Mode routes", () => {
  test("/private returns 200 with no redirect (clean context, no cookies)", async ({
    request,
    page,
  }) => {
    const res = await request.get("/private", {
      maxRedirects: 0,
      headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["location"]).toBeUndefined();
    expect(res.headers()["set-cookie"]).toBeUndefined();

    await page.goto("/private");
    await expect(page).toHaveURL(/\/private$/);
    await expect(page.getByRole("heading", { name: UNAVAILABLE_HEADLINE })).toBeVisible();
  });

  test("/private-sw.js returns 200 JavaScript with no redirect", async ({ request }) => {
    const res = await request.get("/private-sw.js", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()["location"]).toBeUndefined();
    expect(res.headers()["content-type"]).toMatch(/javascript/);
    const body = await res.text();
    expect(body).toContain("MANIFEST");
  });

  test("/private-offline shell URLs return 200 with private headers and no redirect", async ({ request }) => {
    const swBody = await (await request.get("/private-sw.js")).text();
    const manifest = JSON.parse(/const MANIFEST = (\{.*?\});\n/.exec(swBody)![1]) as {
      buildId: string;
      shell: string;
      rsc: string;
    };
    for (const path of [manifest.shell, manifest.rsc]) {
      const res = await request.get(path, {
        maxRedirects: 0,
        headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" },
      });
      expect(res.status(), path).toBe(200);
      expect(res.headers()["location"], path).toBeUndefined();
      expectPrivateHeaders(res.headers());
      expect((await res.text()).length, path).toBeGreaterThan(0);
    }
  });

});

test.describe("Private Mode response headers", () => {
  test("/private carries the exact private CSP; /private/ and / redirect to it", async ({
    request,
    page,
  }) => {
    const csp = EXPECTED.find((h) => h.key === "Content-Security-Policy")!.value;
    expect(csp).toContain(`connect-src 'self' ${R2_ORIGIN}`);
    for (const directive of ["img-src 'none'", "media-src 'none'", "frame-src 'none'"]) expect(csp).toContain(directive);

    const direct = await request.get("/private", { maxRedirects: 0 });
    expect(direct.status()).toBe(200);
    expectPrivateHeaders(direct.headers());

    // Next's trailing-slash redirect: no body, then the canonical URL with the CSP.
    const slash: APIResponse = await request.get("/private/", { maxRedirects: 0 });
    expect(slash.status()).toBe(308);
    expect(slash.headers()["location"]).toBe("/private");
    const followed = await request.get("/private/");
    expect(followed.url()).toMatch(/\/private$/);
    expectPrivateHeaders(followed.headers());

    // The browser sees the same on the final document.
    const navigation = await page.goto("/private/");
    expect(navigation?.url()).toMatch(/\/private$/);
    expectPrivateHeaders(await navigation!.allHeaders());

    const root = await request.get("/", { maxRedirects: 0 });
    expect([307, 308]).toContain(root.status());
    expect(root.headers()["location"]).toBe("/private");
  });

  test("the normal build ships no e2e mock engine code (positive control in private-mock.spec.ts)", async ({
    request,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "Checks server bytes only; browser-independent, so it runs once");
    const sw = await (await request.get("/private-sw.js")).text();
    const manifest = JSON.parse(/const MANIFEST = (\{.*?\});\n/.exec(sw)![1]) as { assets: string[] };
    const scripts = manifest.assets.filter((a) => a.endsWith(".js"));
    expect(scripts.length).toBeGreaterThan(5);
    for (const asset of scripts) {
      const body = await (await request.get(asset)).text();
      expect(body.includes("korum-e2e-mock-provider"), asset).toBe(false);
    }
  });
});

async function shellCacheReady(page: Page): Promise<{ buildCaches: string[]; entries: number }> {
  return page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const names = (await caches.keys()).filter((n) => n.startsWith("korum-private-shell:"));
    let entries = 0;
    for (const name of names) entries += (await (await caches.open(name)).keys()).length;
    return { buildCaches: names, entries };
  });
}

test.describe("Cold offline reload", () => {
  test("after one online visit, /private and /private/ cold-load offline from the service worker with the private CSP", async ({
    context,
    page,
    guard,
    browserName,
  }) => {
    await page.goto("/private");
    await expect(page.getByRole("heading", { name: UNAVAILABLE_HEADLINE })).toBeVisible();

    // Install finishes only after every shell asset is cached (offline-worker.js).
    await expect.poll(() => shellCacheReady(page), { timeout: 60_000 }).toMatchObject({ buildCaches: [expect.any(String)] });
    const { entries } = await shellCacheReady(page);
    expect(entries).toBeGreaterThan(10);
    const controlled = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/private");
      return { scope: registration?.scope, active: registration?.active?.state };
    });
    expect(controlled.scope).toMatch(/\/private$/);
    expect(controlled.active).toBe("activated");
    // WebKit does not expose SW-originated requests; keep its delivery/header checks below.
    if (browserName === "chromium") {
      const precache = (await guard.settle()).filter((r) =>
        r.fromServiceWorker && r.kind === "self" &&
        /^\/private-offline\/[^/]+\/shell\.html$/.test(new URL(r.url).pathname),
      );
      expect(precache.length, "The guard must observe the worker's shell precache request").toBeGreaterThan(0);
    }
    await page.close();

    await context.setOffline(true);
    const offlineStart = Date.now();

    for (const path of ["/private", "/private/"]) {
      const cold = await context.newPage();
      const response: Response | null = await cold.goto(path);
      expect(response, path).not.toBeNull();
      expect(response!.fromServiceWorker(), path).toBe(true);
      expect(response!.status(), path).toBe(200);
      expectPrivateHeaders(await response!.allHeaders());

      // Same key UI as online: the shell hydrates from cached chunks.
      await expect(cold.getByRole("heading", { name: UNAVAILABLE_HEADLINE })).toBeVisible();
      await expect(cold.locator("#korum-composer")).toBeDisabled();
      await expect(cold.getByText("Private chats · this device", { exact: false })).toBeVisible();
      // The SW also answers a same-document fetch with the private headers.
      const fetched = await cold.evaluate(async (p) => {
        const r = await fetch(p, { headers: { RSC: "1" } });
        const names = (await caches.keys()).filter((n) => n.startsWith("korum-private-shell:"));
        const cache = await caches.open(names[0]);
        const keys = await cache.keys();
        const rscKey = keys.find((key) => /\/private-offline\/[^/]+\/shell-rsc\.txt$/.test(new URL(key.url).pathname));
        if (!rscKey) throw new Error("Precached RSC payload missing");
        const expected = await cache.match(rscKey);
        return {
          ok: r.ok, csp: r.headers.get("content-security-policy"),
          contentType: r.headers.get("content-type"), body: await r.text(),
          expected: await expected!.text(),
        };
      }, path);
      expect(fetched.ok, path).toBe(true);
      expect(fetched.csp, path).toBe(EXPECTED[0].value);
      expect(fetched.contentType, path).toBe("text/x-component");
      expect(fetched.expected.length, path).toBeGreaterThan(0);
      expect(fetched.body, path).toBe(fetched.expected);
      await cold.close();
    }

    const all = await guard.settle();
    const escaped = all.filter((r) => r.at >= offlineStart && r.kind !== "self");
    expect(escaped, guard.describe(escaped).join("\n")).toEqual([]);
  });
});
