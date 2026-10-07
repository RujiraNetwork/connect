import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.{ts,tsx}"],
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
    coverage: { include: ["packages/*/src/**/*.ts"] },
  },
});
