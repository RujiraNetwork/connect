import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["packages/companion/src/index.ts"],
  outDir: "packages/companion/dist",
  format: ["esm"],
  target: "node24",
  bundle: true,
  noExternal: ["@rujira/connect-core"],
  clean: true,
  sourcemap: true,
  splitting: false,
});
