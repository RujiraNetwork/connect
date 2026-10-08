# Rujira Connect

Rujira Connect is a Chromium extension that gives dapps access to approved addresses and chain-native signatures from Ledger, Trezor, and encrypted THORChain/XChain keystores. Dapps own transaction preparation, simulation, RPC selection, fees, and broadcasting. The extension reads addresses over direct device connections, manages site permissions, and signs locally. It makes no HTTP, RPC, balance, fee, name-resolution, or telemetry requests. This applies to Monero too.

This is a developer preview. The browser flow and software signing can be exercised locally. Hardware adapters require the device acceptance checks in [Validation](docs/validation.md) before a public mainnet release. See [Monero signing](docs/monero.md) for its prepared-data contract and current source limits.

## Run and load

Use Node.js 24 and pnpm 11.24.0, matching `.tool-versions` and `packageManager`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:browser
```

Install the isolated test browser once with `pnpm exec playwright install chromium`. On Linux, use `--with-deps` to install its system dependencies.

1. Open Chrome’s `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select `packages/extension/dist` after building.
3. Open Rujira Connect, choose **Add an account**, select a source and network, and confirm the address on the device. Ledger pairing uses the browser’s HID chooser. Trezor uses the bundled official Connect engine over direct WebUSB, with local PIN/passphrase/pairing prompts. No hosted Suite page is loaded.
4. On the app's page, click Rujira Connect in Chrome's toolbar to enable the connection. Return to the app to choose which accounts to share. Repeat this after reloading or navigating to a new page. Each signing request opens a separate approval window. Use desktop Chrome 118 or later.
5. For a local dapp, run `pnpm dev:example` and open `http://127.0.0.1:5174`, then click the Connect toolbar icon on that page. The same build supports HTTPS sites and localhost; it has no persistent host permissions.

`pnpm dev` runs a visual UI preview at port 5173. Signing APIs work inside the installed extension; the web preview shows the same interface without extension privileges.

## Supported networks

The registry includes THORChain, Bitcoin, Bitcoin Cash, Litecoin, Dogecoin, Ethereum, BNB Smart Chain, Avalanche C-Chain, Base, Cosmos Hub, XRP Ledger, TRON, Solana, and Monero. Actual methods depend on the registered source, address profile, device model, firmware, and installed app. Dapps must call `getCapabilities()` and check current THORChain inbound network availability independently. See [Signing formats and source support](docs/integration.md#signing-formats).

Trezor THORChain registration uses an Ethereum-derived address and EIP-712 Amino signing. The dapp supplies the prepared EIP-712 representation alongside the Amino document; Connect validates both locally. Trezor does not expose a Cosmos Hub signer through this implementation. Monero addresses are read directly from Ledger or Trezor, or derived locally from an unlocked keystore. Ledger and Trezor sign prepared Monero transactions directly over HID/USB; encrypted keystores sign locally. All three return native signed bytes after local Bulletproof+, CLSAG and commitment-balance verification. No separate app or node configuration is needed.

Account removal also removes that account from every site permission and cancels its pending requests. Wallet metadata and other accounts remain available. Nondefault account paths are shown in account cards and request reviews. Ledger Bitcoin default wallets use account indices 0–100, inclusive.

Hardware accounts show their device model. Settings adds a short local wallet identifier and groups registrations with matching device connections or verified public keys. Ledger Monero uses the wallet selected in the device's app, represented internally by the path marker `device`; Connect does not send a derivation index that the app cannot accept.

## Dapp integration

```ts
import { getRujira } from "@rujira/connect";

const signer = getRujira();
const [account] = await signer.connect({ chains: ["ETH"] });
if (!account) throw new Error("No approved Ethereum account");

const result = await signer.request({
  accountId: account.id,
  chain: "ETH",
  method: "personal_sign",
  params: { message: "48656c6c6f" },
});
```

The SDK also supplies EIP-6963 discovery with an EIP-1193 signing provider, Cosmos offline signers, and Solana Wallet Standard registration. It does not replace an RPC provider. See [Integration](docs/integration.md) for request formats, standard interfaces, error codes, and events. The example app keeps broadcasting visibly outside the extension.

Provider discovery starts after the user clicks the Connect toolbar icon on the current page. Dapps should accept late EIP-6963 announcements or Solana wallet registration, and call `getRujira()` when the user connects rather than caching it before activation.

## Project structure

| Package              | Responsibility                                                               |
| -------------------- | ---------------------------------------------------------------------------- |
| `packages/core`      | Strict request schemas, chain registry, permissions, prepared signing data   |
| `packages/sdk`       | Dapp bridge, EVM discovery, Cosmos and Solana interfaces                     |
| `packages/extension` | MV3 service worker, isolated messaging, approvals, source adapters, React UI |
| `packages/example`   | Dapp integration and separate broadcasting example                           |

TypeScript uses strict checking, exact optional properties, unchecked-index protection, and exhaustive switches. ESLint’s strict and stylistic type-aware rules reject unsafe values, unhandled promises, non-null assertions, deprecated APIs, import cycles, and inaccessible controls; CI allows zero lint warnings. UI code cannot import signing drivers or hardware libraries.

The React, SCSS, component, formatting, and branding patterns follow the sibling `../ui` project. The dark surfaces, typography, spacing, and pink/purple palette are copied into this workspace. Connect uses the supplied Graphic.svg product icon rather than the RUJI token symbol. Fonts and icons are bundled locally. See [Architecture and security](docs/architecture.md).

## Build and packaging

`pnpm build` produces the unpacked extension, compiled SDK/core libraries with declarations, and integration example. The SDK and core package manifests use `publishConfig.exports` to ship compiled `dist` entrypoints; workspace development uses TypeScript sources. Nothing is published or installed into a browser automatically.

The Connect icon source is `packages/extension/src/ui/assets/connect.svg`. Run `pnpm build:icons` after editing it to regenerate Chrome's PNG sizes and the EVM/Solana discovery icon. Distribution signing, store submission, independent security review, and physical device acceptance remain release tasks.
