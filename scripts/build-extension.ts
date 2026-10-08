import { copyFile, cp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "tsup";

import { version } from "../packages/extension/package.json";

await build({
  config: false,
  entry: {
    content: "packages/extension/src/content.ts",
    page: "packages/extension/src/page.ts",
  },
  outDir: "packages/extension/dist",
  format: ["iife"],
  target: "chrome117",
  bundle: true,
  noExternal: [/./],
  splitting: false,
  clean: false,
  sourcemap: true,
  minify: true,
});
const icons = resolve("packages/extension/dist/icons");
await mkdir(icons, { recursive: true });
for (const size of [16, 32, 48, 128])
  await copyFile(
    resolve(`packages/extension/public/icons/${String(size)}.png`),
    resolve(icons, `${String(size)}.png`)
  );
const manifest = {
  manifest_version: 3,
  name: "Rujira Connect",
  version,
  description: "Connect hardware wallets and sign app requests offline.",
  minimum_chrome_version: "118",
  action: {
    default_title: "Rujira Connect",
    default_popup: "index.html?view=popup",
  },
  background: { service_worker: "background.js", type: "module" },
  permissions: ["storage", "alarms", "activeTab", "scripting"],
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'",
  },
  icons: {
    16: "icons/16.png",
    32: "icons/32.png",
    48: "icons/48.png",
    128: "icons/128.png",
  },
};
await writeFile(
  resolve("packages/extension/dist/manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);

await cp(
  "packages/monero-kernel/licenses",
  "packages/extension/dist/licenses/monero",
  { recursive: true }
);
