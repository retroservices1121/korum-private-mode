import { describe, expect, it } from "vitest";
import { cacheName, routeRequest, canCleanOldCaches } from "@/lib/private/web/offline-policy";
const origin = "https://korum.test";
const route = (path: string, mode = "cors", method = "GET", rsc = false) => routeRequest(new URL(path, origin), origin, method, mode, rsc);
describe("offline shell policy", () => {
  it("names caches by build id", () => {
    expect(cacheName("build-a")).toBe("korum-private-shell:build-a");
    expect(cacheName("build-a")).not.toBe(cacheName("build-b"));
  });
  it("handles both private navigations, RSC and static assets", () => {
    expect(route("/private", "navigate")).toBe("navigation");
    expect(route("/private/", "navigate")).toBe("navigation");
    expect(route("/private?_rsc=123", "cors", "GET", true)).toBe("rsc");
    expect(route("/_next/static/chunks/worker.js")).toBe("static");
  });
  it("never handles API, models, other pages or request bodies", () => {
    for (const path of ["/api/anything", "/v1/models/model/params.bin", "https://models.test/v1/model", "/other-page", "/private-other"]) {
      expect(route(path, "navigate")).toBe("ignore");
    }
    expect(route("/private", "navigate", "POST")).toBe("ignore");
  });
  it("keeps old caches while any old or unknown client remains", () => {
    expect(canCleanOldCaches("b", ["a", "b"])).toBe(false);
    expect(canCleanOldCaches("b", [undefined, "b"])).toBe(false);
    expect(canCleanOldCaches("b", ["b", "b"])).toBe(true);
    expect(canCleanOldCaches("b", [])).toBe(true);
  });
});
