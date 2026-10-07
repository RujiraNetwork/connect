import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  root: resolve("packages/example"),
  build: { outDir: "dist", emptyOutDir: true, target: "chrome117" },
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
});
