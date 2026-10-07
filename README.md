# Rujira Connect

Rujira Connect is a Chromium extension that gives dapps access to approved addresses and chain-native signatures from Ledger, Trezor, and encrypted THORChain/XChain keystores. Dapps own transaction preparation, simulation, RPC selection, fees, and broadcasting. The extension reads addresses over direct device connections, manages site permissions, and signs locally. It makes no HTTP, RPC, balance, fee, name-resolution, or telemetry requests. The separate Monero companion is the sole network exception: its current hardware engine prepares transfers using a configured node.

This is a developer preview. The browser flow and software signing can be exercised locally. Hardware adapters require the device acceptance checks in [Validation](docs/validation.md) before a public mainnet release. Monero signing requires the separately installed, patched native engine described in [Monero setup](docs/monero.md); reading and confirming its address does not.

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
4. Run `pnpm dev:example`, open `http://127.0.0.1:5174`, and connect registered accounts. Every signing request opens a separate approval window. Use desktop Chrome 118 or later.

`pnpm dev` runs a visual UI preview at port 5173. Signing APIs work inside the installed extension; the web preview shows the same interface without extension privileges.

## Supported networks

The registry includes THORChain, Bitcoin, Bitcoin Cash, Litecoin, Dogecoin, Ethereum, BNB Smart Chain, Avalanche C-Chain, Base, Cosmos Hub, XRP Ledger, TRON, Solana, and Monero. Actual methods depend on the registered source, address profile, device model, firmware, and installed app. Dapps must call `getCapabilities()` and check current THORChain inbound network availability independently. See [Signing formats and source support](docs/integration.md#signing-formats).

Trezor THORChain registration uses an Ethereum-derived address and EIP-712 Amino signing. The dapp supplies the prepared EIP-712 representation alongside the Amino document; Connect validates both locally. Trezor does not expose a Cosmos Hub signer through this implementation. Monero addresses are read directly from Ledger or Trezor, or derived locally from an unlocked keystore. Monero signing for all three sources uses the local companion and returns transaction bytes without relay. Settings explains companion setup once a Monero account is present.

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

## Project structure

| Package              | Responsibility                                                               |
| -------------------- | ---------------------------------------------------------------------------- |
| `packages/core`      | Strict request schemas, chain registry, permissions, native messages         |
| `packages/sdk`       | Dapp bridge, EVM discovery, Cosmos and Solana interfaces                     |
| `packages/extension` | MV3 service worker, isolated messaging, approvals, source adapters, React UI |
| `packages/companion` | Local native host, encrypted Monero wallet files, device signing engine      |
| `packages/example`   | Dapp integration and separate broadcasting example                           |

TypeScript uses strict checking, exact optional properties, unchecked-index protection, and exhaustive switches. ESLint’s strict and stylistic type-aware rules reject unsafe values, unhandled promises, non-null assertions, deprecated APIs, import cycles, and inaccessible controls; CI allows zero lint warnings. UI code cannot import signing drivers or hardware libraries.

The React, SCSS, component, formatting, and branding patterns follow the sibling `../ui` project. The Rujira symbol, pink/purple gradient, dark surfaces, typography, and spacing are copied into this workspace. Fonts and icons are bundled locally. See [Architecture and security](docs/architecture.md).

## Build and packaging

`pnpm build` produces the unpacked extension, compiled SDK/core libraries with declarations, integration example, and bundled Node native host. The SDK and core package manifests use `publishConfig.exports` to ship compiled `dist` entrypoints; workspace development uses TypeScript sources. Nothing is published or installed into a browser automatically.

The Monero engine is built separately with `pnpm companion:build-engine`. Its build downloads the pinned upstream source and applies the included device-signing patch. The installer records the exact extension ID in Chrome’s native messaging allowlist. Distribution signing, store submission, independent security review, and physical device acceptance remain release tasks.
