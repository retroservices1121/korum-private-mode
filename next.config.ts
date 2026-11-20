import { randomUUID } from "node:crypto";
import { modelsOrigin } from "./lib/private/core/models-host";
import type { NextConfig } from "next";

import { privateHeaders } from "./lib/private/core/private-headers.mjs";

export const PRIVATE_HEADERS = privateHeaders(modelsOrigin(), process.env.NODE_ENV === "development");

const privateBuildId = randomUUID();

/**
 * End-to-end test builds only (see `playwright.config.ts`): swaps the WebLLM
 * engine for a scripted mock. It is inlined as a literal, so normal builds
 * ("0") drop the mock code entirely. A mock build must go to its own distDir,
 * and is refused whenever KORUM_DEPLOY=1 marks a build meant for deployment.
 */
const e2eMockProvider = process.env.KORUM_E2E_MOCK_PROVIDER === "1";
const distDir = e2eMockProvider ? process.env.KORUM_E2E_DIST_DIR || ".next" : ".next";
if (e2eMockProvider && (distDir === ".next" || process.env.KORUM_DEPLOY === "1")) {
  throw new Error("KORUM_E2E_MOCK_PROVIDER needs KORUM_E2E_DIST_DIR and is refused for deploy builds (KORUM_DEPLOY=1)");
}

const nextConfig: NextConfig = {
  generateBuildId: async () => privateBuildId,
  distDir,
  // A mock build keeps its own type includes, so Next never rewrites tsconfig.json for it.
  ...(e2eMockProvider ? { typescript: { tsconfigPath: "tsconfig.e2e-mock.json" } } : {}),
  env: {
    NEXT_PUBLIC_PRIVATE_BUILD_ID: privateBuildId,
    KORUM_E2E_MOCK_PROVIDER: e2eMockProvider ? "1" : "0",
  },
  async redirects() {
    // Private Mode lives at /private (the service worker scope, the offline
    // shell and the CSP all key off that path); the root just points there.
    return [{ source: "/", destination: "/private", permanent: false }];
  },
  async headers() {
    return [
      { source: "/private-sw.js", headers: [
        { key: "Service-Worker-Allowed", value: "/private" },
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
      ] },
      { source: "/private-offline/:path*", headers: PRIVATE_HEADERS },
      { source: "/private", headers: PRIVATE_HEADERS },
      { source: "/private/:path*", headers: PRIVATE_HEADERS },
    ];
  },
};

export default nextConfig;
