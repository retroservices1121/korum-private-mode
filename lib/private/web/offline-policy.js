/** Shared by the generated service worker and unit tests. */
export const CACHE_PREFIX = "korum-private-shell:";
export function cacheName(buildId) { return `${CACHE_PREFIX}${buildId}`; }
export function routeRequest(url, origin, method, mode, rsc = false) {
  if (method !== "GET" || url.origin !== origin || url.pathname.startsWith("/api/")) return "ignore";
  if (url.pathname.startsWith("/_next/static/")) return "static";
  if (url.pathname === "/private" || url.pathname === "/private/") {
    if (mode === "navigate") return "navigation";
    if (rsc) return "rsc";
  }
  return "ignore";
}
/** Unknown client versions are retained conservatively. */
export function canCleanOldCaches(current, clientVersions) {
  return clientVersions.every((version) => version === current);
}
