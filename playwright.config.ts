import { defineConfig, devices } from "@playwright/test";

import { MOCK_PORT, MOCK_URL, PLAIN_PORT, PLAIN_URL } from "./e2e/support/urls";

/**
 * Private Mode end-to-end suite. Runs against production builds:
 *
 *   - :3100 — the normal production build (`npm run build && npm start`),
 *     used for the unavailable state, privacy, CSP and offline tests;
 *   - :3101 — the same app built with KORUM_E2E_MOCK_PROVIDER=1 into
 *     `.next-e2e-mock`, whose scripted on-device engine lets the renderer,
 *     message-action and prompt-canary tests run without a GPU.
 *
 * The network guard handles intercepted non-self requests locally. WebKit
 * does not expose worker-originated traffic (see e2e/support/network.ts).
 * Webservers start one after the other, so the
 * two builds never overlap. Fresh builds every run; KORUM_E2E_REUSE=1 reuses
 * servers already listening.
 */

/** Overrides anything in the shell or a local .env file, so builds use the defaults. */
const E2E_ENV: Record<string, string> = {
  NEXT_PUBLIC_KORUM_MODELS_BASE_URL: "",
  KORUM_E2E_MOCK_PROVIDER: "",
  KORUM_E2E_DIST_DIR: "",
  KORUM_DEPLOY: "",
};

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: PLAIN_URL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: [
    {
      command: `npm run build && npx next start -p ${PLAIN_PORT}`,
      url: `${PLAIN_URL}/private`,
      env: E2E_ENV,
      timeout: 600_000,
      reuseExistingServer: process.env.KORUM_E2E_REUSE === "1",
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `npx next build && npx next start -p ${MOCK_PORT}`,
      url: `${MOCK_URL}/private`,
      env: { ...E2E_ENV, KORUM_E2E_MOCK_PROVIDER: "1", KORUM_E2E_DIST_DIR: ".next-e2e-mock" },
      timeout: 600_000,
      reuseExistingServer: process.env.KORUM_E2E_REUSE === "1",
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
