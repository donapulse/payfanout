import { defineConfig } from "@playwright/test";

/**
 * Browser E2E against the demo app with REAL PSP sandbox keys — the only layer
 * that exercises the true Stripe.js / Paysafe.js SDKs, iframes, and 3DS
 * challenges. Specs self-skip without keys.
 *
 * One-time setup: pnpm --filter @payfanout/e2e e2e:install   (downloads Chromium)
 * Run:            pnpm run e2e   (with VITE_STRIPE_PUBLISHABLE_KEY etc. set)
 */
export default defineConfig({
  testDir: "./test",
  testMatch: /.*\.e2e\.ts/,
  timeout: 90_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter payfanout-demo dev:server",
      port: 4242,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "pnpm --filter payfanout-demo dev:web",
      port: 5173,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
