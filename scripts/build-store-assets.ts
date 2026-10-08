import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, expect } from "@playwright/test";
import { format, resolveConfig } from "prettier";

import {
  CHAINS,
  accountPath,
  stateSchema,
  supportedMethods,
} from "../packages/core/src/index";
import { version } from "../packages/extension/package.json";
import { toHex } from "../packages/extension/src/adapters/bytes";
import {
  addressFor,
  privateKeyFor,
  publicKeyFor,
} from "../packages/extension/src/adapters/keys";
import {
  moneroPrivateKeys,
  moneroPublicKeys,
} from "../packages/extension/src/adapters/monero-keys";

import type { StoredState, WalletSource } from "../packages/core/src/index";

const directory = resolve("releases/chrome-web-store");
await mkdir(resolve(directory, "source"), { recursive: true });
await mkdir(resolve(directory, "source/licenses"), { recursive: true });

async function save(name: string, contents: string): Promise<void> {
  const path = resolve(directory, name);
  await writeFile(
    path,
    name.endsWith(".html") || name.endsWith(".json")
      ? await format(contents, {
          ...(await resolveConfig(path)),
          filepath: path,
        })
      : contents
  );
}

async function demoState(): Promise<StoredState> {
  const previous = await readFile(
    resolve(directory, "source/demo-accounts.json"),
    "utf8"
  ).catch(() => undefined);
  if (previous) return stateSchema.parse(JSON.parse(previous) as unknown);
  const ledger: WalletSource = {
    id: randomUUID(),
    kind: "ledger",
    label: "Ledger Nano X",
    deviceName: "Ledger Nano X",
  };
  const trezor: WalletSource = {
    id: randomUUID(),
    kind: "trezor",
    label: "Trezor Safe 3",
    deviceName: "Trezor Safe 3",
  };
  const seeds = { ledger: randomBytes(64), trezor: randomBytes(64) };
  try {
    const accounts = (
      [
        { chain: "BTC", source: ledger, profile: "default" },
        { chain: "XMR", source: trezor, profile: "default" },
        { chain: "THOR", source: ledger, profile: "default" },
        { chain: "THOR", source: trezor, profile: "evm" },
      ] as const
    ).map(({ chain, source, profile }) => {
      const path = accountPath(chain, 0, source.kind, profile);
      const scheme = profile === "evm" ? "eip712" : "native";
      if (source.kind === "keystore") throw new Error("Hardware demo only");
      const seed = seeds[source.kind];
      let address: string;
      let publicKey: string;
      if (chain === "XMR") {
        const keys = moneroPrivateKeys(seed, path);
        try {
          address = keys.address;
          publicKey = moneroPublicKeys(address).publicKey;
        } finally {
          keys.spend.fill(0);
          keys.view.fill(0);
        }
      } else {
        const privateKey = privateKeyFor(seed, chain, path);
        try {
          const publicBytes = publicKeyFor(privateKey, chain);
          publicKey = toHex(publicBytes);
          address = addressFor(chain, publicBytes, path, scheme);
        } finally {
          privateKey.fill(0);
        }
      }
      return {
        id: randomUUID(),
        sourceId: source.id,
        source: source.kind,
        chain,
        address,
        publicKey,
        path,
        scheme,
        label: `${CHAINS[chain].name} 1`,
        verifiedAt: Date.now(),
        methods: [...supportedMethods(chain, source.kind, scheme)],
      };
    });
    const state = stateSchema.parse({
      version: 1,
      sources: [ledger, trezor],
      accounts,
      grants: [],
    });
    await save("source/demo-accounts.json", JSON.stringify(state));
    return state;
  } finally {
    seeds.ledger.fill(0);
    seeds.trezor.fill(0);
  }
}

const description = `Use your hardware wallet with web apps.

Rujira Connect reads addresses from your Ledger or Trezor and lets you review and sign requests from connected apps. You can also import a supported encrypted keystore and sign locally on your computer.

Add an account
Plug in your device, choose a network and add an account. Connect reads the address directly from your hardware wallet. Bitcoin, Monero and THORChain are supported, alongside other networks. Availability depends on your device, firmware and installed apps.

Choose what an app can access
Open Connect from your browser toolbar on the app's page, then return to the app to choose which accounts to share. Open Connect again after reloading or moving to a new page. Review each signing request in Connect. For a hardware account, confirm it on your device. Connect returns the signed request to the app.

Keep connection and signing local
Connect makes no network requests. It does not query balances, contact network nodes or broadcast transactions. The connecting app handles transaction preparation and network activity, including the network work needed for Monero.

Manage your accounts
See which device each account belongs to, copy an address or remove an account. Removing an account also removes its access from connected sites. You can disconnect a site whenever you need to.

Use an encrypted keystore
Import a THORChain or XChain keystore and unlock it locally. It locks again after five minutes, and you can lock it yourself at any time.

By Rujira Network
https://rujira.network/
`;
const summary =
  "Connect your Ledger, Trezor or encrypted keystore to web apps. Share addresses and sign requests locally.";
if (summary.length > 132) throw new Error("Store summary is too long");
await save("description.txt", description);
await save("summary.txt", `${summary}\n`);
for (const family of ["montserrat", "barlow-semi-condensed"])
  await save(
    `source/licenses/${family}.txt`,
    await readFile(
      resolve(`packages/extension/node_modules/@fontsource/${family}/LICENSE`),
      "utf8"
    )
  );

const dataImage = (type: string, bytes: Uint8Array): string =>
  `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
const logo = dataImage(
  "image/svg+xml",
  await readFile("packages/extension/src/ui/assets/connect.svg")
);
async function font(family: string, weight: number): Promise<string> {
  const bytes = await readFile(
    resolve(
      `packages/extension/node_modules/@fontsource/${family}/files/${family}-latin-${String(weight)}-normal.woff2`
    )
  );
  return dataImage("font/woff2", bytes);
}
const fonts = `
@font-face { font-family: Montserrat; font-style: normal; font-weight: 600; src: url('${await font("montserrat", 600)}') format('woff2'); }
@font-face { font-family: Barlow; font-style: normal; font-weight: 400; src: url('${await font("barlow-semi-condensed", 400)}') format('woff2'); }
`;
const profile = await mkdtemp(resolve(tmpdir(), "rujira-store-assets-"));
const extension = resolve("packages/extension/dist");
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
});
try {
  const state = await demoState();
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async (state) => {
    await chrome.storage.local.set({ state });
  }, state);
  const manager = await context.newPage();
  const runtimeErrors: string[] = [];
  manager.on("pageerror", (error) => runtimeErrors.push(error.message));
  await manager.goto(
    `chrome-extension://${new URL(worker.url()).hostname}/index.html`
  );
  await expect(manager.locator("article.account")).toHaveCount(4);
  for (const chain of ["BTC", "XMR", "THOR"])
    await expect(
      manager.locator(`article.account [data-network='${chain}']`).first()
    ).toBeVisible();
  await manager.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(manager.locator("article.account strong").first()).toHaveText(
    "Ledger Nano X"
  );
  await expect(manager.locator("article.account strong").nth(1)).toHaveText(
    "Trezor Safe 3"
  );
  await expect(manager.locator("article.account strong").last()).toHaveText(
    "Trezor Safe 3 · m/44'/60'/0'/0/0"
  );
  const last = await manager.locator("article.account").last().boundingBox();
  if (!last || last.y + last.height > 800)
    throw new Error("Screenshot cuts off an account");
  expect(runtimeErrors).toEqual([]);
  await manager.screenshot({
    path: resolve(directory, "screenshot-1280x800.png"),
  });
  const app = await manager.locator(".app").boundingBox();
  if (!app) throw new Error("Missing account screen");
  const preview = await manager.screenshot({
    path: resolve(directory, "source/account-preview.png"),
    clip: {
      x: app.x,
      y: app.y,
      width: app.width,
      height: last.y + last.height + 25,
    },
  });

  const artwork = await context.newPage();
  const icon = await artwork.evaluate(async (logo) => {
    const image = new Image();
    image.src = logo;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const paint = canvas.getContext("2d");
    if (!paint) throw new Error("Cannot render store icon");
    paint.drawImage(image, 8, 8, 112, 112);
    return canvas.toDataURL("image/png").split(",")[1];
  }, logo);
  if (!icon) throw new Error("Missing icon export");
  await writeFile(
    resolve(directory, "icon-128.png"),
    Buffer.from(icon, "base64")
  );

  const brand = `<div class="brand"><img src="${logo}" alt="Rujira Connect"/><div><strong>RUJIRA</strong><span>CONNECT</span></div></div>`;
  const common = `
${fonts}
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; height: 100%; }
body { background: #0c0a0f; color: #ffffff; font-family: Barlow, sans-serif; overflow: hidden; }
.brand { display: flex; align-items: center; gap: 14px; }
.brand img { width: 44px; height: 44px; }
.brand strong { display: block; font: 600 17px Montserrat, sans-serif; letter-spacing: 4px; }
.brand span { display: block; margin-top: 4px; font: 400 13px Barlow, sans-serif; letter-spacing: 5.4px; color: #90a4ae; }
.credit { color: #90a4ae; font-size: 17px; }
`;
  const small = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Rujira Connect — small promotional tile</title><style>${common}
.tile { width: 440px; height: 280px; padding: 29px 32px; position: relative; background: radial-gradient(ellipse at 110% 85%, #8436f539 0%, transparent 61%), #0c0a0f; }
.tile::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, #8436f5, #d615eb); }
.brand img { width: 38px; height: 38px; }
.brand strong { font-size: 14px; letter-spacing: 3.4px; }
.brand span { font-size: 10px; letter-spacing: 4.65px; }
h1 { margin: 29px 0 11px; font: 600 29px/1.19 Montserrat, sans-serif; letter-spacing: -0.8px; }
.devices { margin: 0; color: #b4b0c0; font-size: 17px; }
.credit { margin-top: 24px; font-size: 13px; }
</style></head><body><main class="tile">${brand}<h1>Sign with your<br/>hardware wallet.</h1><p class="devices">Ledger · Trezor · Encrypted keystores</p><div class="credit">by Rujira Network</div></main></body></html>`;
  const marquee = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Rujira Connect — marquee promotional tile</title><style>${common}
.tile { width: 1400px; height: 560px; position: relative; padding: 51px 64px; background: radial-gradient(ellipse at 98% 50%, #8436f534 0%, transparent 65%), #0c0a0f; }
.tile::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg, #8436f5, #d615eb); }
.copy { width: 622px; }
h1 { margin: 42px 0 23px; font: 600 48px/1.16 Montserrat, sans-serif; letter-spacing: -1.8px; }
.detail { margin: 0; font-size: 25px; line-height: 1.4; color: #b4b0c0; }
.local { margin-top: 24px; color: #90a4ae; font-size: 21px; }
.credit { position: absolute; bottom: 44px; left: 64px; }
.product { position: absolute; left: 760px; top: 22px; width: 566px; height: 516px; overflow: hidden; border: 1px solid #ffffff1a; border-radius: 20px; background: #0c0a0f; box-shadow: 0 10px 35px #00000040; }
.product img { display: block; width: 566px; height: auto; }
</style></head><body><main class="tile"><div class="copy">${brand}<h1>Use your hardware wallet<br/>with web apps.</h1><p class="detail">Connect a Ledger or Trezor by USB.<br/>Share an address and approve signing on your device.</p><p class="local">Connection and signing run locally.<br/>Apps handle balances and broadcasting.</p></div><div class="product"><img src="${dataImage("image/png", preview)}" alt="Bitcoin, Monero and THORChain demo accounts on Ledger Nano X and Trezor Safe 3"/></div><div class="credit">by Rujira Network</div></main></body></html>`;
  for (const asset of [
    { name: "promo-small-440x280", html: small, width: 440, height: 280 },
    { name: "promo-marquee-1400x560", html: marquee, width: 1400, height: 560 },
  ]) {
    await save(`source/${asset.name}.html`, asset.html);
    await artwork.setViewportSize({ width: asset.width, height: asset.height });
    await artwork.setContent(asset.html);
    await artwork.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((image) => image.decode()));
    });
    await artwork.screenshot({ path: resolve(directory, `${asset.name}.png`) });
  }
  await save(
    "asset-info.json",
    JSON.stringify({
      product: "Rujira Connect",
      version,
      images: [
        { file: "icon-128.png", width: 128, height: 128, transparency: true },
        {
          file: "screenshot-1280x800.png",
          width: 1280,
          height: 800,
          transparency: false,
        },
        {
          file: "promo-small-440x280.png",
          width: 440,
          height: 280,
          transparency: false,
        },
        {
          file: "promo-marquee-1400x560.png",
          width: 1400,
          height: 560,
          transparency: false,
        },
      ],
      screenshot:
        "Actual packaged extension with synthetic public accounts in an isolated temporary Chrome profile. Addresses were derived locally from two random seeds, which were discarded. No physical devices or existing wallet data were used.",
      branding:
        "Connect SVG supplied by the user; palette and fonts follow ../ui and the existing extension.",
      specifications: "https://developer.chrome.com/docs/webstore/images",
      regenerate: "pnpm build:store-assets",
    })
  );
  process.stdout.write(`Store assets saved to ${directory}\n`);
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
