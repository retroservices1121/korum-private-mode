import { runInNewContext } from "node:vm";
import nextConfig, { PRIVATE_HEADERS } from "../next.config";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPrivateOffline } from "../scripts/build-private-offline.mjs";
import { it, expect } from "vitest";
it("postbuild publishes static HTML/RSC and includes nested worker/font chunks", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "korum-offline-"));
  try {
    for (const dir of [".next/server/app", ".next/static/chunks/nested", ".next/static/media", "lib/private/web"]) mkdirSync(path.join(root, dir), { recursive: true });
    for (const file of ["offline-worker.js", "offline-policy.js"]) copyFileSync(`lib/private/web/${file}`, path.join(root, "lib/private/web", file));
    for (const [file, text] of Object.entries({
      ".next/BUILD_ID": "test-build", ".next/server/app/private.html": "<html>static shell</html>",
      ".next/server/app/private.rsc": "static rsc", ".next/static/chunks/nested/worker.js": "worker", ".next/static/media/font.woff2": "font",
    })) writeFileSync(path.join(root, file), text);
    await buildPrivateOffline(root);
    expect(readFileSync(path.join(root, "public/private-offline/test-build/shell.html"), "utf8")).toContain("static shell");
    // Next never serves a public `*.rsc` file (it routes `.rsc` as an RSC request), so precaching it 404s.
    expect(readFileSync(path.join(root, "public/private-offline/test-build/shell-rsc.txt"), "utf8")).toBe("static rsc");
    expect(readFileSync(path.join(root, "public/private-sw.js"), "utf8")).not.toMatch(/\.rsc"/);
    const sw = readFileSync(path.join(root, "public/private-sw.js"), "utf8");
    expect(sw).toContain('"buildId":"test-build"');
    expect(sw).toContain("/_next/static/chunks/nested/worker.js");
    expect(sw).toContain("/_next/static/media/font.woff2");
    expect(sw).not.toContain("export ");
    // Generated classic worker must be syntactically valid.
    expect(() => new Function(sw)).not.toThrow();
    expect(await nextConfig.headers!()).toContainEqual({ source: "/private-offline/:path*", headers: PRIVATE_HEADERS });
    const listeners = new Map<string, (event: unknown) => void>();
    runInNewContext(sw, {
      self: { location: { origin: "https://korum.test" }, addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn) },
      caches: { open: async () => ({ match: async () => new Response("<html>offline</html>") }) },
      fetch: async () => { throw new Error("offline"); },
      URL, Response, Headers,
    });
    for (const pathname of ["/private", "/private/"]) {
      let result!: Promise<Response>;
      listeners.get("fetch")!({
        request: { url: "https://korum.test" + pathname, method: "GET", mode: "navigate", headers: new Headers() },
        respondWith: (response: Promise<Response>) => { result = response; },
      });
      const response = await result;
      for (const { key, value } of PRIVATE_HEADERS) expect(response.headers.get(key)).toBe(value);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
