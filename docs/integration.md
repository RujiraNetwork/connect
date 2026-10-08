# Dapp integration

Dapps request access to locally registered accounts, inspect capabilities, and submit native signing data. Account IDs identify a source, network, derivation path, and address profile. An address alone does not identify which signer to use.

Users first open Rujira Connect from Chrome's toolbar on the app's page. This temporarily enables the provider in that document without granting persistent access to all sites. After a reload or navigation, users open Connect again. Accept EIP-6963 announcements and Solana Wallet Standard registrations that arrive after page load. For the typed API, call `getRujira()` at connection time; if it is unavailable, ask the user to open the toolbar popup and retry. Saved account grants remain scoped to their approved origins and do not automatically enable new tabs.

## Address permissions

```ts
import { getRujira } from "@rujira/connect";

const provider = getRujira();
const accounts = await provider.connect({
  chains: ["THOR", "BTC", "ETH", "SOL"],
});
const current = await provider.getAccounts();
const capabilities = await provider.getCapabilities();
const unsubscribe = provider.on("accountsChanged", (accounts) => {
  // Refresh application selection from the newly approved public accounts.
});
await provider.disconnect();
unsubscribe();
```

`connect` displays an explicit account chooser. `getAccounts` returns only accounts approved for the exact requesting origin, including its port. A fresh origin sees an empty list. Registration never automatically shares an address. Grants persist until revoked; unlocking a keystore does not grant signing permission. Each signature needs a new approval.

Public account metadata includes `id`, `chain`, `address`, `publicKey` when available, `source`, `scheme`, and `methods`. It excludes encrypted keystores, device identifiers, paths, and secret material. `getCapabilities` returns `version`, `signingOnly`, and the approved account methods. There is no broad “all networks” permission.

## Signing formats

Each request has `{ accountId, chain, method, params }`. Responses have `{ accountId, chain, method, payload }`. Request schemas are exported from `@rujira/connect` and reject unknown fields. Hex byte strings accept an optional `0x` prefix; base64 fields use standard base64. Monetary integers are decimal or hexadecimal strings where specified, never floating point coin amounts.

| Network family       | Method                  | Parameters                                                                                   | Returned payload                                      |
| -------------------- | ----------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| EVM                  | `eth_signTransaction`   | Prepared transaction with `from`, `chainId`, `nonce`, `gasLimit`, fees, recipient/value/data | Serialized signed transaction hex                     |
| EVM                  | `personal_sign`         | `{ message: hexBytes }`                                                                      | EIP-191 signature hex                                 |
| EVM                  | `eth_signTypedData_v4`  | EIP-712 `{ domain, types, message, primaryType? }`                                           | EIP-712 signature hex                                 |
| THORChain and Cosmos | `signAmino`             | Standard Amino sign document                                                                 | `{ signed, signature }`                               |
| THORChain and Cosmos | `signDirect`            | `{ bodyBytes: hex, authInfoBytes: hex, chainId, accountNumber: decimal }`                    | Direct sign document and signature                    |
| Bitcoin and Litecoin | `signPsbt`              | `{ psbt: base64, inputs: number[] }`                                                         | `{ psbt: base64 }` with selected input signatures     |
| UTXO chains          | `signUtxoTransaction`   | `{ transactionHex, inputs: [{ index, previousTransactionHex, value: decimal }] }`            | `{ transactionHex }` with selected input signatures   |
| Solana               | `signSolanaTransaction` | `{ transaction: base64 }`, legacy or v0                                                      | `{ transaction: base64 }` preserving other signatures |
| Solana               | `signSolanaMessage`     | `{ message: hexBytes }`                                                                      | `{ signature: base64 }`                               |
| XRP                  | `signXrpTransaction`    | Prepared canonical XRP transaction JSON                                                      | `{ tx_blob, hash }`                                   |
| TRON                 | `signTronTransaction`   | Prepared transaction JSON including `raw_data`, `raw_data_hex`, and `txID`                   | Native transaction JSON with signature                |
| Monero               | `signMoneroTransaction` | Prepared native construction data, rings, key images, outputs, and exact fee                 | `{ transactionHex, transactionHash, fee, amount }`    |

UTXO signing supports registered P2PKH and native SegWit paths with SIGHASH_ALL; Bitcoin Cash uses SIGHASH_ALL with FORKID. It checks complete previous transactions, outpoints, amounts, and account scripts. Taproot, arbitrary script policies, and alternate sighash modes are rejected. Supply all input values when relying on the UI’s fee display. Non-owned inputs retain their existing signatures.

| Source   | EVM                        | THORChain                                      | Cosmos Hub   | UTXO                                                                     | Solana                        | XRP                  | TRON                              | Monero                                    |
| -------- | -------------------------- | ---------------------------------------------- | ------------ | ------------------------------------------------------------------------ | ----------------------------- | -------------------- | --------------------------------- | ----------------------------------------- |
| Ledger   | Native Ethereum signer kit | Native THORChain Amino or Ethereum app EIP-712 | Amino        | Bitcoin PSBT/native; Litecoin native; BCH/DOGE native                    | Transaction/message           | Native transaction   | Native transaction                | Direct prepared signing                   |
| Trezor   | Official Connect           | Ethereum profile EIP-712 Amino                 | Unavailable  | PSBT/native for supported Bitcoin and Litecoin profiles; BCH/DOGE native | Supported models and firmware | Payment transactions | Supported native contract formats | Direct prepared signing, supported models |
| Keystore | Native                     | Amino/direct                                   | Amino/direct | PSBT/native                                                              | Transaction/message           | Native transaction   | Native transaction                | Local prepared signing                    |

These are implemented paths, not a certification of every firmware/model combination. Query account capabilities and handle an unsupported request. Trezor XRP currently supports simple prepared Payment transactions; advanced XRP fields and unsupported TRON contracts fail explicitly. THORChain uses its custom Cosmos Web3 domain types, including string-valued contract and salt fields. Its EIP-712 adapter validates the dapp's prepared representation against the approved Amino document. Add a top-level `typedData` field to the `signAmino` request for an Ethereum-app THORChain account; `params` remains the standard Amino document. The prepared representation uses primary type `Tx` and the Cosmos Web3 domain from THORChain. Every approved Amino field must be included. No node conversion is performed inside Connect.

Ledger Bitcoin default-wallet registration accepts indices 0–100 inclusive, matching the [Ledger app specification](https://github.com/LedgerHQ/app-bitcoin/blob/develop/doc/wallet.md#default-wallets). Larger account policies and custom HD paths are outside this adapter.

## EVM standards

EIP-6963 announces Rujira Connect under `network.rujira.connect`. Use its announced provider or `window.rujira.ethereum`. It implements address discovery, selected chain ID, approved chain switching, transaction/message/typed-data signing, and `on`/`removeListener`/`off`. EVM account events contain addresses for the selected chain only; `chainChanged` uses a hexadecimal chain ID.

`eth_sendTransaction`, `eth_sendRawTransaction`, balance queries, fee estimation, chain addition, and RPC passthrough are unsupported. Pair the signing provider with a dapp-owned RPC client. Prepare nonce, gas, chain ID, and fees before asking for a signature; broadcast the returned bytes from your application.

## Cosmos standards

```ts
const signer = window.rujira?.cosmos.getOfflineSignerOnlyAmino("thorchain-1");
if (!signer) throw new Error("Rujira Connect is unavailable");
const [account] = await signer.getAccounts();
if (!account) throw new Error("Connect a THORChain account first");
const response = await signer.signAmino(account.address, signDoc);
// Ethereum-app THORChain profile: app prepares typedData beforehand.
const ethProfileResponse = await signer.signAmino(account.address, signDoc, {
  typedData,
});
```

`getOfflineSigner`, `getOfflineSignerOnlyAmino`, `getOfflineSignerAuto`, and `enable` are exposed through `window.rujira.cosmos`. `getAccounts` returns `AccountData` with a `Uint8Array` public key. The direct signer accepts native `Uint8Array` body/auth bytes and a bigint account number, then converts them to the transport’s JSON format. Select an Amino signer for Ledger or the THORChain EIP-712 profile. Native THORChain uses `tendermint/PubKeySecp256k1`; Ethereum-derived THORChain uses `os/PubKeyEthSecp256k1`.

## Solana standards

Rujira Connect registers through Wallet Standard with `standard:connect`, `standard:disconnect`, `standard:events`, `solana:signTransaction`, and `solana:signMessage`. It supports `solana:mainnet`, legacy transactions, and v0 transactions. The dapp resolves lookup tables, prepares instructions, and broadcasts. `signAndSendTransaction` is deliberately absent.

## Monero request

```ts
import { preparedMoneroTransactionSchema } from "@rujira/connect";

// Prepare native construction data in the dapp's Monero wallet engine.
const prepared = preparedMoneroTransactionSchema.parse(constructionData);
if (!account.methods.includes("signMoneroTransaction")) {
  throw new Error("This account does not support the requested Monero format");
}
const result = await provider.request({
  accountId: account.id,
  chain: "XMR",
  method: "signMoneroTransaction",
  params: prepared,
});
// The dapp decides whether and where to broadcast result.payload.transactionHex.
```

The dapp scans, discovers spendable outputs, synchronizes key images, obtains decoys, estimates fees, and prepares the transaction. Connect validates the construction data, displays the recipient and exact fee, obtains device approval, and returns native transaction bytes without contacting a node. There is no destination-only transfer API, automatic scan, fee selection, or RPC URL in Connect.

Ledger, Trezor and encrypted keystores sign prepared transfers with one standard mainnet recipient and change, 16-member rings, CLSAG and Bulletproof+. Use `format: "monero-prepared-v1"`; the older `trezor-monero-v1` name remains accepted. See [Monero contract and limits](monero.md).

## Errors and lifecycle

| Code   | Meaning                                                |
| ------ | ------------------------------------------------------ |
| 4001   | User declined or closed the approval                   |
| 4100   | Account or origin is unauthorized                      |
| 4200   | Unsupported chain method, format, or device capability |
| 4900   | Extension, page, or device disconnected                |
| 4901   | Wrong network                                          |
| -32003 | Keystore locked                                        |
| -32002 | Request busy or rate limited                           |
| -32004 | Approval expired                                       |
| -32602 | Invalid request                                        |
| -32603 | Internal signing error                                 |

An approval expires after five minutes. Page navigation, closing its approval window, account/source removal, and locking cancel pending requests. Origin permissions are checked again before returning signed data. Only one approval/device operation runs at a time. Site requests are limited to 30 per minute. A restarted service worker locks software sessions; a subsequent request reconnects the content bridge automatically.

## Solana message results

Ledger and keystore `signSolanaMessage` return `{ signature }`, with a base64 signature over the requested hex message bytes. Current Trezor firmware signs the Solana off-chain v1 envelope and returns `{ signature, signedData }`; `signedData` contains the exact signed envelope as hex. Connect checks the envelope's domain, version, sole signer and message bytes before accepting the signature. Trezor supports UTF-8 messages; binary messages fail explicitly. Dapps must verify the returned signed bytes when this field is present.
