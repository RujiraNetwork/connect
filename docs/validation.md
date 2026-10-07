# Validation and release acceptance

Automated tests verify permission boundaries and native signing formats with public test keys. A physical device and funded Monero wallet are required to validate the hardware and native engine paths before a public release.

## Automated checks

`pnpm check` runs formatting, strict lint, TypeScript checking, unit tests, and all TypeScript production builds. `pnpm peers check` verifies dependency compatibility. `pnpm test:browser` launches an isolated Chromium profile with the built unpacked extension and a generated encrypted keystore containing a public BIP39 fixture. It imports the keystore, registers Ethereum and a Bitcoin account with a nondefault HD path, checks Ledger Bitcoin index boundaries, removes one connected account, verifies account-change events, approves origin-specific access, verifies a real EIP-191 signature, denies broadcasting, declines a request, locks software signing, and revokes access. It never uses a personal browser profile or funded account.

The second browser test uses a simulated Nano S HID device with the actual bundled Ledger transport and SDK. It checks direct Monero registration while generic app-status commands cannot respond, handshake timeout and clean retry, Cosmos address APDUs, nondefault path display, full model labels, account icon controls, duplicate source cleanup, and Monero signing setup in Settings. It uses only public test keys and does not replace physical-device acceptance.

Unit tests cover exact-origin permissions, chain mismatch, request digests, keystore encryption compatibility, wrong passwords, session expiry and seed-buffer clearing, replay/expiry/navigation/window cancellation, raw acknowledgements, native framing, independent EVM signing, Amino/direct signing, selected UTXO signatures and SIGHASH restrictions, Solana message preservation, XRP signing, Monero address/checksum derivation, hardware source grouping, and native Monero signing setup bound to the registered address.

The native patch can be checked with `git apply --check` against the pinned source. The CI Monero job compiles both wallet binaries with the patch and enforces Trezor availability. A patch application check does not substitute for the native compile or a physical signing test.

## Device checks

Use separately recorded model, firmware, app version, operating system, browser version, address profile, and test transaction hash for every completed check. Registered addresses must match both the device screen and an independent chain client.

| Area                       | Acceptance                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger pairing             | HID chooser requires a user gesture; wrong app, disconnect, denied chooser, device switch, and locked device fail without storing a false registration                                              |
| Trezor pairing             | Direct USB discovery, bundled Connect initialization with HTTP blocked, local PIN/passphrase/pairing flow, cancellation, different passphrase, and unsupported model/firmware are handled correctly |
| EVM                        | Register all four networks; sign a prepared transaction, personal message, and typed data; independently recover the registered signer and decode chain/fee/recipient fields                        |
| THORChain native           | Confirm Ledger coin-931 address and Amino signature against an independent THORChain client                                                                                                         |
| THORChain Ethereum profile | Confirm the Ethereum-derived thor address, dapp-prepared typed-data validation with the extension offline, and `os/PubKeyEthSecp256k1` signature on both vendors                                    |
| Cosmos Hub                 | Ledger Amino address/signature matches a standard Cosmos offline signer; Trezor is clearly unavailable                                                                                              |
| UTXO                       | Test BTC/LTC supported SegWit and legacy paths, BCH FORKID, DOGE native transactions, multiple inputs, non-owned input preservation, and mismatched previous transactions                           |
| Solana                     | Legacy/v0 transaction and message signing preserves message bytes and every existing signature                                                                                                      |
| XRP and TRON               | Supported prepared native transactions retain all approved fields and recover the registered address; advanced unsupported Trezor forms fail explicitly                                             |
| Monero registration        | Direct offline address reading and confirmation with no companion installed; Ledger on-device wallet selection, Trezor hardened path/passphrase, checksum/public-key validation, and timeout/retry  |
| Monero signing             | Fund a dedicated test wallet; refresh, sync Trezor key images, sign, independently decode amounts/fees, and submit from a separate dapp RPC client; verify the companion never relays               |
| Monero lifecycle           | Wrong password, missing host, stock engine, interrupted scan, device removal, stale approval, fee ceiling, native process exit, restart, and custom node persistence                                |

Hardware tests must use mainnet-format requests for the registered mainnet accounts. Sending funds or broadcasting is a separate explicit action by the tester; registration and signing alone must never submit a transaction.

## Release gates

Complete independent security review of derivation, device identity, request binding, THORChain encoding, and the Monero native patch. Package and sign native binaries/runtime for supported operating systems, include upstream and dependency licenses, and verify native-host allowlists. Review browser-store CSP and permissions, vendor SDK data loading, accessible popup/approval sizes, recovery after service-worker restart, and source removal. Store publishing and native installer distribution are separate from the workspace implementation.
