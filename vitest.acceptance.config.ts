import { defineConfig } from "vitest/config";

// Dedicated config for the live acceptance suite. The default vitest.config.ts
// EXCLUDES *.live.test.ts (so `npm test` stays offline); this config includes
// only the live suite so `npm run test:acceptance` can find and run it.
export default defineConfig({
  test: {
    include: ["tests/**/*.live.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Live government APIs can be slow; give each test room before failing.
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
