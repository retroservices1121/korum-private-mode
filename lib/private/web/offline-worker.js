/* global PRIVATE_HEADERS, MANIFEST, cacheName, canCleanOldCaches, CACHE_PREFIX, routeRequest */
/* Template concatenated with the manifest and shared policy by postbuild. */
const CURRENT = cacheName(MANIFEST.buildId);
const versions = new Map();
async function cleanup() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (!canCleanOldCaches(MANIFEST.buildId, clients.filter((c) => /^\/private\/?$/.test(new URL(c.url).pathname)).map((c) => versions.get(c.id)))) return;
  for (const name of await caches.keys()) {
    if (name.startsWith(CACHE_PREFIX) && name !== CURRENT) await caches.delete(name);
  }
}
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CURRENT);
    // No credentials or personalized HTML: shell bytes come from the static build.
    for (const url of [MANIFEST.shell, MANIFEST.rsc, ...MANIFEST.assets]) {
      const response = await fetch(url, { credentials: "omit", cache: "reload", redirect: "error" });
      if (!response.ok) throw new Error("Private shell precache failed");
      await cache.put(url, response);
    }
    // Default waiting lifecycle: old tabs keep their old worker and chunks.
  })());
});
self.addEventListener("activate", (event) => { event.waitUntil(cleanup()); });
self.addEventListener("message", (event) => {
  if (event.data?.type === "private-shell-version" && event.source?.id) {
    versions.set(event.source.id, event.data.buildId);
    event.waitUntil(cleanup());
  }
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const route = routeRequest(new URL(request.url), self.location.origin, request.method, request.mode, request.headers.get("RSC") === "1");
  if (route === "ignore") return;
  event.respondWith((async () => {
    const cache = await caches.open(CURRENT);
    if (route === "static") {
      // A worker serves only its own version's chunks. Never delete another worker's cache here.
      return await cache.match(request) || fetch(request);
    }
    try {
      const response = await fetch(request);
      if (response.ok) return response;
    } catch { /* Offline navigation falls back to the build's static shell. */ }
    const response = await cache.match(route === "rsc" ? MANIFEST.rsc : MANIFEST.shell);
    if (!response) return Response.error();
    const headers = new Headers(response.headers);
    for (const { key, value } of PRIVATE_HEADERS) headers.set(key, value);
    if (route === "rsc") {
      headers.set("Content-Type", "text/x-component");
      return new Response(response.body, { headers });
    }
    return new Response(response.body, { headers });
  })());
});
