import { readFile, writeFile } from "node:fs/promises";

import { chromium } from "@playwright/test";

const svg = await readFile(
  "packages/extension/src/ui/assets/connect.svg",
  "utf8"
);
await writeFile(
  "packages/sdk/src/icon.ts",
  `// Generated from the Connect SVG by pnpm build:icons.\nexport const CONNECT_ICON_SVG =\n  ${JSON.stringify(svg)};\n`
);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    const png = await page.evaluate(
      async ({ svg, size }) => {
        const image = new Image();
        image.src = `data:image/svg+xml;base64,${btoa(svg)}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not draw the Connect icon");
        context.drawImage(image, 0, 0, size, size);
        return canvas.toDataURL("image/png").split(",")[1];
      },
      { svg, size }
    );
    if (!png) throw new Error("Could not export the Connect icon");
    await writeFile(
      `packages/extension/public/icons/${String(size)}.png`,
      Buffer.from(png, "base64")
    );
  }
} finally {
  await browser.close();
}
