# Architecture and security

Rujira Connect separates untrusted dapp messages, extension approvals, and signing drivers. Dapps never receive secrets or hardware handles. The extension does not offer balance queries, transaction history, swaps, fee estimation, or transaction broadcasting.

## Trust boundaries

The page’s main-world script exposes standards and the typed SDK. Its requests cross `postMessage` into an isolated content script, then a Chrome runtime port into the MV3 service worker. The background derives the origin and document identity from Chrome’s sender metadata. Claimed page origins cannot grant permission. Only top-level HTTPS pages and localhost development pages are accepted.

The service worker validates strict schemas, message sizes, request identities, chain IDs, registered public keys, account ownership, and origin grants. An approval is bound to the exact canonical request digest and originating document. Navigation, timeout, window closure, or locking discards the pending approval. Account permissions are checked again after signing before returning the result. State mutations are serialized to prevent a slow registration from overwriting a permission change.

Only the extension’s own `index.html` may invoke trusted UI commands. A content script cannot import a keystore, approve its own request, or unlock a source. Local storage access is restricted to trusted extension contexts. The UI receives public source labels and account metadata, never encrypted keystore contents. It does collect passwords briefly to pass to the background and clears them after the operation; passwords are never persisted.

## Hardware and secret handling

Ledger WebHID uses the current Device Management Kit and its HID transport. Ethereum, Bitcoin, and Solana use modern signer kits; other app protocols use a small compatibility transport over DMK APDUs. Monero address registration connects directly at the official HID transport layer, bypassing generic session pings and app switching. It uses only the Monero handshake, public-key request, and address display. A registered address is confirmed on the device and recomputed or checked against its public key. Signing checks the account again. No private hardware keys leave the device.

Ledger transport IDs are temporary, so reconnecting can recognise a saved wallet by reading a known public key. Registrations are grouped by a current transport identity or matching verified keys, never by model name alone. Monero connections compare saved Monero addresses without switching to unrelated apps; select an existing device entry when reconnecting to a wallet whose only saved accounts use another app. Settings' short identifier belongs to the local wallet record, not a hardware serial number. Model names come from the vendor SDK.

Trezor uses the bundled official Connect core over direct USB. The transport coordinates sessions in memory, without Bridge or remotely hosted workers. PIN, passphrase, and pairing responses are bound to the active local request and are never stored. Online firmware checks fall back to packaged firmware data; firmware updates are outside this product. Monero addresses use the bundled `moneroGetAddress` method. Monero signing uses the native device implementation, including Trezor key-image synchronization and cold transaction signing. Browser hardware connections are released before the native engine owns the device.

THORChain/XChain keystores stay encrypted in local storage. AES-128-CTR decryption uses PBKDF2-HMAC-SHA256 and verifies the format’s BLAKE2b MAC before parsing its BIP39 mnemonic. Derived seed bytes live in an expiring in-memory session for at most five minutes; explicit lock, service-worker restart, and expiry remove access and overwrite the retained seed buffer. JavaScript strings and internal cryptographic copies cannot guarantee physical memory erasure, so this is an exposure reduction, not a memory-isolation guarantee.

The Monero host receives only derived spend/view keys for software registration, never the mnemonic. Monero’s native wallet engine encrypts its wallet files with the user’s separate local password. Hardware wallet files can include private view material used for scanning, but retain device-owned spend keys. The host exposes a framed native messaging protocol only to the configured extension ID. Its internal wallet RPC listens on loopback with fresh Digest credentials; wallet passwords and RPC credentials use private temporary files instead of process arguments, and are removed on orderly shutdown. A crashed host can leave private temporary files; its application data directory must remain accessible only to the user.

## Request review and verification

Approvals display the requesting origin, network, registered signing address, and decoded fields when available. Valid data that cannot be fully described requires explicit acknowledgement of the complete payload. Message review requires acknowledgement for invalid UTF-8, control characters, and bidirectional text controls. Hardware users also confirm on the device.

Returned signatures and transaction bytes are checked against the expected account and approved payload. EVM fields and recovered addresses must match; UTXO inputs/outputs and selected signatures must match; Solana messages and other signatures must remain intact; Cosmos documents, XRP fields, and TRON raw bytes must remain unchanged. THORChain’s dapp-prepared EIP-712 representation must preserve every approved Amino value and its complete schema. Missing data, omitted fields, changed values, or an unexpected Cosmos Web3 domain fail before approval. Connect never calls a THORChain node.

Monero transaction parsing and hardware cryptography remain in the native engine. The host checks address ownership, destination validity, exact requested amount, the maximum fee, and approval digest. The extension verifies the returned totals. Full independent decoding of a Monero RingCT blob is outside the TypeScript adapter; the patched engine and its device confirmation are part of the trusted signing boundary.

## Browser permissions and packaging

The manifest requests `storage`, `alarms`, and `nativeMessaging`. Content-script matching is limited to HTTPS and localhost. There are no host permissions or externally connectable Suite origins. The extension CSP uses `connect-src 'none'` and forbids remote frames. A background fetch guard rejects SDK HTTP fallbacks before any request is sent. Ledger signer kits receive an offline context module: no metadata, token resolution, telemetry, name resolution, or Solana RPC fetches. Trezor blockchain workers are excluded at build time. Fonts, icons, branding, and signing libraries are bundled locally.

The separate native Monero companion is the only network exception. The current Monero hardware engine cannot use upstream's `sign_transfer` path, which rejects hardware wallets. Its supported transfer path refreshes outputs and prepares ring data using the configured node, then signs without relay. This is a limitation of the current engine integration, not a claim that Monero cryptography requires an internet connection. App-prepared offline hardware transaction support would require a separate native integration and acceptance tests. The extension never displays balances or broadcasts transactions.

UI styling follows `../ui`: React, SCSS tokens, Montserrat and Barlow Semi Condensed typography, Inconsolata for addresses, Rujira’s logo paths, and the pink/purple gradient. Presentation components cannot import signing or hardware modules. The core schemas are shared by SDK, background, and companion to keep the contract consistent.

## Scope of version 0.1

The implementation supports one explicitly registered derivation path per account, mainnet chain IDs, and a single approval at a time. It does not discover balances across account indices, manage recovery phrases, install firmware/apps, sign multisig policies, handle Taproot descriptors, or automatically authorize newly registered addresses. Monero engine packaging and native host installation are separate from browser extension loading.

Release acceptance requires device/model verification, the native engine build, store policy review, and independent review of signing and permission boundaries. Detailed checks are in [Validation](validation.md).
