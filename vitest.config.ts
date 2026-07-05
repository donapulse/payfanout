import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests hit real PSP sandboxes; unit tests finish in ms either way.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
      // types.ts modules are interface-only: no runtime code ever loads them.
      exclude: ["packages/e2e/**", "packages/*/src/types.ts"],
      reporter: ["text-summary", "html"],
      // Ratchet these up, never down. Measured 94.9/87.1/95.7; small
      // headroom left for legitimate future changes.
      thresholds: {
        lines: 92,
        functions: 92,
        statements: 92,
        branches: 82,
      },
    },
  },
});
