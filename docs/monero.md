# Monero companion setup

Monero addresses connect offline without a companion. Ledger uses its public-key and address-display commands over the official HID transport; Trezor uses the bundled `moneroGetAddress` method. Keystore addresses are derived locally. Registration validates the address checksum and public keys and asks hardware users to confirm the address. It does not export private hardware keys or contact a node.

Signing uses a local Rujira native host and a patched Monero wallet engine. Hardware spend keys stay on Ledger or Trezor. Software signing setup passes derived keys into an encrypted native wallet. Every transfer returns signed transaction bytes with `do_not_relay` enabled; the dapp submits them separately.

Monero is the sole exception to Connect’s local-only signing contract. The current native engine needs a node to scan outputs and prepare rings. Upstream’s standard `sign_transfer` API rejects hardware wallets, so accepting an app-prepared unsigned file is not a drop-in replacement for this Ledger/Trezor flow. That does not mean Monero signatures inherently need a network connection. A future offline hardware path should delegate output discovery and transaction preparation to the dapp.

## Build the engine

The build pins Monero v0.18.4.6 at commit `dbcc7d212c094bd1a45f7291dbb99a4b4627a96d`, verifies the checkout, and applies `packages/companion/native/device-signing.patch`. Read the [upstream build requirements](https://github.com/monero-project/monero/tree/v0.18.4.6#compiling-monero-from-source). Install CMake, a C++ compiler, Boost, OpenSSL, Unbound, libsodium, ZeroMQ, HIDAPI, libusb, readline, protobuf/protoc, and the Trezor Python protobuf dependencies. The Linux CI job includes a concrete dependency setup.

```sh
pnpm companion:build-engine --source /absolute/path/to/new/monero-build --jobs 2
```

The source directory must be new. Binaries are written to `build/rujira/bin` inside it. The script fails if CMake silently disables Trezor support. Keep the upstream license and third-party notices with distributed binaries. Builds for macOS and Windows need the corresponding upstream toolchain; the included host installer handles Chrome registration on those platforms after the engine exists.

The patch adds the same key-image sync and cold-signing calls used by Monero’s CLI to the RPC transfer path. This matters for Trezor: an unmodified RPC `transfer` path does not finish cold signing. The patched `get_version` reports `rujira_device_signing: 1`. The host probes this marker before using the engine and rejects stock binaries. The patched transfer path rejects relay requests.

## Install the native host

Build the workspace, load the unpacked extension, and copy its ID from Chrome’s extension page.

```sh
pnpm build
pnpm companion:install \
  --extension-id <32-character-extension-id> \
  --engine-dir /absolute/path/to/monero-build/build/rujira/bin
```

The installer is explicit and local. It writes a launcher, bundled host, private configuration, and native messaging manifest for the exact extension ID. It uses the current Node.js executable, so retain a working Node 24 installation at that path. If the extension ID changes, reinstall its manifest. Chrome must be restarted if it does not discover a newly registered host.

The data locations are `~/Library/Application Support/Rujira Connect` on macOS, `~/.local/share/rujira-connect` on Linux, and `%LOCALAPPDATA%\Rujira\Connect` on Windows. Wallet files are encrypted by Monero; the directory must remain private. The manifest goes in Chrome’s user NativeMessagingHosts directory or its Windows HKCU registry entry. Other Chromium distributions need their own native-host registration location.

## Register an address

Choose Monero in the extension’s registration form. Select the source, connect the device, and confirm the address. Open the Monero app on Ledger first; Connect uses its on-device wallet selection and does not show an account-index field. Trezor supports `m/44'/128'/account'`. Unlock an imported keystore before registration. No native wallet password, restore height, companion, or node is needed to add an address.

Ledger Monero registration bypasses DMK's generic session ping and app-switch actions. It sends only the native Monero client handshake, public-key request, and address-display request. The handshake and public-key read have ten-second deadlines; device confirmation allows almost five minutes. An error identifies the failed step and closes the connection so another attempt can start cleanly.

Settings prompts for companion setup after adding a Monero account. The first signing request creates an encrypted native wallet using the registered account ID and verifies its address against the browser record. Its current scan starts at height zero. Subsequent requests reuse that wallet. Unlock a software keystore before its first signing setup.

Signing prompts for the native wallet password every time. This password unlocks the encrypted local wallet; it is distinct from a keystore password, Ledger PIN, or Trezor passphrase. The signer must use the same device/passphrase that registered the address. The engine verifies the primary address again before signing.

## Node and transfer behavior

The default public node is `https://xmr-node.cakewallet.com:18081`. Settings can select another HTTPS node or an HTTP node on localhost. Public-node RPC is treated as untrusted. Use your own node when you want control over the service that sees your scan requests. Availability and scan time depend on the node and restore height.

The native engine refreshes outputs, creates one standard transfer, synchronizes Trezor key images when required, asks the hardware to sign, and returns raw bytes. The host rejects split transactions, nonzero transfer account indices, memo-bearing transfers, fee mismatches, destination/network mismatches, and unsafe JSON integer amounts. A THORChain Monero deposit must use current memo-less deposit instructions prepared by the dapp.

Saving a node updates the private `config.json` and survives native-host restarts. The installer also accepts `--node <https-url>`. Forgetting a browser source currently removes browser permissions and metadata; remove corresponding encrypted native wallet files manually if retiring that source entirely.

## Validation and distribution

The TypeScript host builds with the workspace and the native patch applies cleanly to the pinned source. Complete the native build and hardware tests in [Validation](validation.md) before distributing a mainnet installer. No binaries are fetched and executed by the extension. A future packaged installer must ship verified engine binaries and a stable Node runtime, include licenses, and be signed for each target operating system.

Implementation references are Monero’s [CLI cold signing](https://github.com/monero-project/monero/blob/v0.18.4.6/src/simplewallet/simplewallet.cpp) and [wallet RPC transfer](https://github.com/monero-project/monero/blob/v0.18.4.6/src/wallet/wallet_rpc_server.cpp).
