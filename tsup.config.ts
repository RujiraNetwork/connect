import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["packages/core/src/index.ts"],
    outDir: "packages/core/dist",
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: ["packages/sdk/src/index.ts"],
    outDir: "packages/sdk/dist",
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    noExternal: ["@rujira/connect-core"],
  },
]);
