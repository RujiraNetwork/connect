# Architecture and security

Rujira Connect separates untrusted dapp messages, extension approvals, and signing drivers. Dapps never receive secrets or hardware handles. The extension does not offer balance queries, transaction history, swaps, fee estimation, or transaction broadcasting.

## Trust boundaries

The page’s main-world script exposes standards and the typed SDK. Its requests cross `postMessage` into an isolated content script, then a Chrome runtime port into the MV3 service worker. The background derives the origin and document identity from Chrome’s sender metadata. Claimed page origins cannot grant permission. Only top-level HTTPS pages and localhost development pages are accepted.

The service worker validates strict schemas, message sizes, request identities, chain IDs, registered public keys, account ownership, and origin grants. An approval is bound to the exact canonical request digest and originating document. Navigation, timeout, window closure, or locking discards the pending approval. Account permissions are checked again after signing before returning the result. State mutations are serialized to prevent a slow registration from overwriting a permission change.

Only the extension’s own `index.html` may invoke trusted UI commands. A content script cannot import a keystore, approve its own request, or unlock a source. Local storage access is restricted to trusted extension contexts. The UI receives public source labels and account metadata, never encrypted keystore contents. It does collect passwords briefly to pass to the background and clears them after the operation; passwords are never persisted.

## Hardware and secret handling

Ledger WebHID uses the current Device Management Kit and its HID transport. Ethereum, Bitcoin, and Solana use modern signer kits; other app protocols use a small compatibility transport over DMK APDUs. Monero address registration connects directly at the official HID transport layer, bypassing generic session pings and app switching. Registration uses the Monero handshake, public-key request and address display. Signing uses the app’s native v4 transfer protocol with opaque encrypted/HMAC secret handles, device fee/recipient confirmation and host-generated Bulletproof+ proofs. A registered address is confirmed on the device and recomputed or checked against its public key. Signing checks the account again. No private hardware keys leave the device.

Ledger transport IDs are temporary, so reconnecting can recognise a saved wallet by reading a known public key. Registrations are grouped by a current transport identity or matching verified keys, never by model name alone. Monero connections compare saved Monero addresses without switching to unrelated apps; select an existing device entry when reconnecting to a wallet whose only saved accounts use another app. Settings' short identifier belongs to the local wallet record, not a hardware serial number. Model names come from the vendor SDK.

Trezor uses the bundled official Connect core over direct USB. The transport coordinates sessions in memory, without Bridge or remotely hosted workers. PIN, passphrase, and pairing responses are bound to the active local request and are never stored. Online firmware checks fall back to packaged firmware data; firmware updates are outside this product. Monero addresses use the bundled `moneroGetAddress` method. Monero signing uses the bundled `moneroSignTransaction` method with validated, dapp-prepared construction data. It supports the two-output flow whose range proof is generated on the device; larger output batches require an offloading protocol that is not exposed by this adapter.

THORChain/XChain keystores stay encrypted in local storage. AES-128-CTR decryption uses PBKDF2-HMAC-SHA256 and verifies the format’s BLAKE2b MAC before parsing its BIP39 mnemonic. Derived seed bytes live in an expiring in-memory session for at most five minutes; explicit lock, service-worker restart, and expiry remove access and overwrite the retained seed buffer. JavaScript strings and internal cryptographic copies cannot guarantee physical memory erasure, so this is an exposure reduction, not a memory-isolation guarantee.

## Request review and verification

Approvals display the requesting origin, network, registered signing address, and decoded fields when available. Valid data that cannot be fully described requires explicit acknowledgement of the complete payload. Message review requires acknowledgement for invalid UTF-8, control characters, and bidirectional text controls. Hardware users also confirm on the device.

Returned signatures and transaction bytes are checked against the expected account and approved payload. EVM fields and recovered addresses must match; UTXO inputs/outputs and selected signatures must match; Solana messages and other signatures must remain intact; Cosmos documents, XRP fields, and TRON raw bytes must remain unchanged. THORChain’s dapp-prepared EIP-712 representation must preserve every approved Amino value and its complete schema. Missing data, omitted fields, changed values, or an unexpected Cosmos Web3 domain fail before approval. Connect never calls a THORChain node.

Monero requests bind the actual output public keys to checksum-verified destination addresses. Change must return to the registered account; inputs must cover the outputs and the exact fee. Ring members and key images have canonical ordering, counts, and valid curve points. Device results are decoded locally, with authenticated signature decryption, native v2/RingCT serialization, prefix-hash binding to the prepared input data, exact-fee checks, and recomputed transaction hashes. Every returned Monero transaction is independently parsed and checked with the pinned, packaged monero-oxide WebAssembly kernel: Bulletproof+, every CLSAG/key image, commitment balance and transaction hash. The kernel has no wallet database, RPC or WASI imports. Keystore spend/view and transaction-secret buffers are erased after signing, along with the kernel’s entire linear memory. Hardware firmware still owns device-side key custody and output derivation.

## Browser permissions and packaging

The manifest requests `storage` and `alarms`. Content-script matching is limited to HTTPS and localhost. There are no host permissions or externally connectable Suite origins. The extension permits packaged WebAssembly with `wasm-unsafe-eval`. Its CSP uses `connect-src 'none'` and forbids remote frames. A background fetch guard rejects SDK HTTP fallbacks before any request is sent. Ledger signer kits receive an offline context module: no metadata, token resolution, telemetry, name resolution, or Solana RPC fetches. Trezor blockchain workers are excluded at build time. Fonts, icons, branding, and signing libraries are bundled locally.

All network work, including Monero output discovery, decoy selection, key-image synchronization, fee estimation, and broadcasting, belongs to the dapp. Connect has no native host, loopback service, node setting, native-messaging permission, or network exception. Monero view material is never exported implicitly during registration or signing; a dapp must already have the watch-only wallet and key-image data needed to prepare its inputs.

UI styling follows `../ui`: React, SCSS tokens, Montserrat and Barlow Semi Condensed typography, Inconsolata for addresses, the supplied Connect product icon, and the pink/purple gradient. Presentation components cannot import signing or hardware modules. The core schemas are shared by SDK and background to keep the contract consistent.

## Scope of version 0.1

The implementation supports one explicitly registered derivation path per account, mainnet chain IDs, and a single approval at a time. It does not discover balances across account indices, manage recovery phrases, install firmware/apps, sign multisig policies, handle Taproot descriptors, or automatically authorize newly registered addresses. All three sources implement prepared Monero transfer signing within the two-output mainnet contract.

Release acceptance requires device/model verification, store policy review, and independent review of signing and permission boundaries. Detailed checks are in [Validation](validation.md).
