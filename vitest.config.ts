import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Live suites (real government API calls) are opt-in via `npm run test:acceptance`.
    exclude: ["dist/**", "node_modules/**", "tests/**/*.live.test.ts"],
  },
});
