import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/extension/src/adapters/*.hardware.test.ts"],
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
