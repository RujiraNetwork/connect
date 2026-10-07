# Dapp integration

Dapps request access to locally registered accounts, inspect capabilities, and submit native signing data. Account IDs identify a source, network, derivation path, and address profile. An address alone does not identify which signer to use.

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
| Monero               | `signMoneroTransfer`    | Destinations, priority, accountIndex, maxFee, restoreHeight                                  | `{ transactionHex, transactionHash, fee, amount }`    |

UTXO signing supports registered P2PKH and native SegWit paths with SIGHASH_ALL; Bitcoin Cash uses SIGHASH_ALL with FORKID. It checks complete previous transactions, outpoints, amounts, and account scripts. Taproot, arbitrary script policies, and alternate sighash modes are rejected. Supply all input values when relying on the UI’s fee display. Non-owned inputs retain their existing signatures.

| Source   | EVM                        | THORChain                                      | Cosmos Hub   | UTXO                                                                     | Solana                        | XRP                  | TRON                              | Monero                              |
| -------- | -------------------------- | ---------------------------------------------- | ------------ | ------------------------------------------------------------------------ | ----------------------------- | -------------------- | --------------------------------- | ----------------------------------- |
| Ledger   | Native Ethereum signer kit | Native THORChain Amino or Ethereum app EIP-712 | Amino        | Bitcoin PSBT/native; Litecoin native; BCH/DOGE native                    | Transaction/message           | Native transaction   | Native transaction                | Patched companion, Monero app       |
| Trezor   | Official Connect           | Ethereum profile EIP-712 Amino                 | Unavailable  | PSBT/native for supported Bitcoin and Litecoin profiles; BCH/DOGE native | Supported models and firmware | Payment transactions | Supported native contract formats | Patched companion, supported models |
| Keystore | Native                     | Amino/direct                                   | Amino/direct | PSBT/native                                                              | Transaction/message           | Native transaction   | Native transaction                | Patched companion, derived keys     |

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
const result = await provider.request({
  accountId: account.id,
  chain: "XMR",
  method: "signMoneroTransfer",
  params: {
    destinations: [{ address: recipient, amount: "100000000000" }],
    priority: 1,
    accountIndex: 0,
    restoreHeight: 0,
    maxFee: "10000000000",
  },
});
```

Amounts and fees are piconero. Addresses register directly and offline; the companion is needed only for signing. Ledger's account path is `device`, meaning the wallet selected in its Monero app. Trezor uses a hardened account path. The first signing request creates a native wallet bound to the registered address and scans from height zero; `restoreHeight` in a transfer does not change an existing wallet's scan settings. `accountIndex` inside a transfer must be zero. Monero is the only network exception. The companion refreshes outputs before signing because the current hardware engine uses its transfer-preparation path; the standard unsigned-transfer API rejects hardware wallets. The dapp still handles broadcasting. Standard memo-less transfers are supported; use THORChain’s current memo-less deposit instructions for Monero. Integrated addresses remain subject to the native engine’s validation. Requests above JSON’s safe integer limit are rejected rather than rounded.

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
