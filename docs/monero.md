# Offline Monero connection and signing

Monero addresses connect directly to Ledger over WebHID or Trezor over WebUSB. Keystore addresses are derived locally. Ledger uses the wallet selected in its Monero app, represented internally by `device`; Trezor uses `m/44'/128'/account'`. Registration verifies the checksum and public keys and asks hardware users to confirm the address. It never exports private hardware keys or contacts a node.

## Division of responsibility

The dapp owns wallet scanning, spendable-output discovery, key-image synchronization, decoy selection, fee estimation, transaction preparation, and broadcasting. It must already possess the watch-only wallet data and key images required to prepare inputs. Connect does not expose a private view-key export or a key-image synchronization API yet, and never requests those secrets implicitly.

Connect accepts prepared construction data, checks it locally, displays the recipient, amount, exact fee, and change, and asks the device to sign. It returns `{ transactionHex, transactionHash, fee, amount }`; amounts and fees in the result are decimal piconero strings. The dapp can broadcast the returned transaction. No companion, native wallet file, local password, restore height, priority selector, node URL, or network request is part of this flow.

## Prepared request

Use `signMoneroTransaction` and the SDK's exported `PreparedMoneroTransaction` type and `preparedMoneroTransactionSchema`. The old destination-only `signMoneroTransfer` request is rejected. `params` contains:

- `format: "monero-prepared-v1"` (the older `trezor-monero-v1` alias is accepted) and `networkType: 0`.
- `inputs`: native Trezor/Monero source entries containing amounts, commitment masks, transaction public keys, real-output positions, minor subaddress indices, and 16 ring members with global output indices and destination/commitment keys.
- `keyImages`: the corresponding 32-byte key images in input order. Inputs must be sorted by descending key-image bytes, as Monero requires. These are checked against Ledger/keystore input derivation and the signed native transaction; Trezor also binds them through its returned prefix hash.
- `tsx_data`: native Trezor transaction construction data with one standard mainnet recipient and one change output, exact fee, account zero, `num_inputs`, `minor_indices`, no integrated indices, mixin 15, hard fork 16, unlock time zero, client version 3, and construction version 1.
- `tsx_data.rsig_data`: `{ rsig_type: 3, bp_version: 4, grouping: [2] }`. This selects the two-output Bulletproof+ flow. Ledger and keystore proofs are generated locally; Trezor generates its proof on the device. The serialized transaction version is 2.

Output entries include `amount`, `original` (address), `addr.spend_public_key`, `addr.view_public_key`, `is_subaddress: false`, and `is_integrated: false`. `change_dts` must appear exactly once in the output list and belong to the registered account. Address strings and public keys must agree. Native numeric amounts and global indices must be safe JS integers; larger values are rejected instead of rounded. The dapp must validate current chain conditions and use its own Monero construction engine to create real input/ring data. The SDK schema validates the transport shape, not blockchain availability.

## Current limits

Direct transaction signing is implemented for Ledger’s Monero protocol v4, supported Trezor firmware through bundled Connect core and direct USB, and encrypted keystores with local spend/view key derivation. The initial format supports 1–32 RingCT inputs, 16-member rings, a standard mainnet recipient plus change, CLSAG, and Bulletproof+. Integrated addresses, recipient subaddresses, extra payment IDs, arbitrary unlock times, multiple recipients, and multisig are outside this format.

## Verification

The packaged WebAssembly kernel verifies each native transaction's Bulletproof+, CLSAG signatures against the prepared rings/key images, commitment balance and transaction hash. Its crypto dependencies are pinned to monero-oxide commit `731657ae3385be667abb556266369a497bc86f13`. This verifies cryptographic validity locally; the dapp remains responsible for actual chain outputs, unspent status, decoy policy and current network fees.

Ledger Nano S app 2.1.1 has been exercised on published Speculos 0.23.0, with real signature mode, encrypted secret handles, ring positions 0, 2 and 15, and a two-input transfer using a minor subaddress and an additional transaction key. The captured APDUs replay in normal tests using Ledger's published mock transport. Trezor Model T firmware 2.12.5 has been exercised with the published trezor-user-env emulator; its native result is saved as a public-seed regression fixture. Keystore tests cover 1–2 inputs, minor subaddresses, additional transaction keys and rejection of altered proof/signature data. No funded wallet or transaction broadcast was used.

See [hardware tests](hardware-tests.md) to rerun firmware tests and [kernel build](../packages/monero-kernel/README.md) to reproduce the bundled cryptography. Physical-device and security-review release checks remain in [Validation](validation.md).

The adapter follows the [Trezor Monero signing protocol](https://github.com/trezor/trezor-firmware/tree/main/core/src/apps/monero/signing) and [Monero RingCT serialization](https://github.com/monero-project/monero/blob/v0.18.4.6/src/ringct/rctTypes.h).

Ledger follows the [official Ledger Monero app](https://github.com/LedgerHQ/app-monero). Host cryptography uses [monero-oxide](https://github.com/monero-oxide/monero-oxide).
