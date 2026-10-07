import { resolve } from "node:path";

import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  root: resolve("packages/extension"),
  base: "./",
  resolve: {
    alias: {
      "cross-fetch": resolve(
        "packages/extension/src/adapters/offline-fetch.ts"
      ),
    },
  },
  plugins: [
    {
      name: "trezor-offline-backends",
      enforce: "pre",
      resolveId(source, importer) {
        if (
          importer?.includes("/@trezor/connect-core/lib/core/") &&
          /(?:^|\/)method(?:\.js)?$/.test(source)
        )
          return resolve(
            "packages/extension/src/adapters/offline-trezor-methods.ts"
          );
        if (
          importer?.includes("/@trezor/connect-core/") &&
          /\/workers\/workers(?:\.js)?$/.test(source)
        )
          return resolve("packages/extension/src/adapters/offline-workers.ts");
        return undefined;
      },
    },
    react(),
    nodePolyfills({
      include: ["buffer", "events", "stream", "crypto", "util", "process"],
      globals: { Buffer: true, process: true, global: true },
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "chrome117",
    rollupOptions: {
      input: {
        index: resolve("packages/extension/index.html"),
        background: resolve("packages/extension/src/background/index.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background"
            ? "background.js"
            : "assets/[name]-[hash].js",
      },
    },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
