import { Buffer } from "buffer";

import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import {
  canonicalJson,
  ConnectError,
  ERROR_CODES,
  validateSignAccount,
} from "@rujira/connect-core";
import { Transaction, script, payments } from "bitcoinjs-lib";
import { SignDoc } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { SigningKey, hashMessage } from "ethers";
import { validate, Wallet } from "xrpl";

import { base64, fromHex, toHex } from "./bytes";
import { addressFor, privateKeyFor, publicKeyFor } from "./keys";
import { signMoneroSoftware } from "./monero-crypto";
import { moneroKeys, moneroPublicKeys } from "./monero-keys";
import {
  evmTransaction,
  previousOutput,
  solanaKey,
  solanaTransaction,
  typedData,
  validatePsbt,
  validateTron,
  validateUtxo,
} from "./transactions";

import type { Account, SignRequest } from "@rujira/connect-core";
import type { Transaction as XrpTransaction } from "xrpl";

export function registerSoftware(
  seed: Uint8Array,
  account: Omit<Account, "address" | "publicKey">
): Account {
  if (account.chain === "XMR") {
    const { address } = moneroKeys(seed, account.path);
    return {
      ...account,
      address,
      publicKey: moneroPublicKeys(address).publicKey,
    };
  }
  const privateKey = privateKeyFor(
    seed,
    account.chain === "THOR" && account.scheme === "eip712"
      ? "ETH"
      : account.chain,
    account.path
  );
  try {
    const publicKey = publicKeyFor(privateKey, account.chain);
    return {
      ...account,
      address: addressFor(
        account.chain,
        publicKey,
        account.path,
        account.scheme
      ),
      publicKey: toHex(publicKey),
    };
  } finally {
    privateKey.fill(0);
  }
}

export function signSoftware(
  seed: Uint8Array,
  account: Account,
  request: SignRequest
): unknown {
  validateSignAccount(account, request);
  if (request.method === "signMoneroTransaction")
    return signMoneroSoftware(seed, account, request.params);
  const privateKey = privateKeyFor(
    seed,
    account.chain === "THOR" && account.scheme === "eip712"
      ? "ETH"
      : account.chain,
    account.path
  );
  try {
    const publicKey = publicKeyFor(privateKey, account.chain);
    if (
      account.publicKey !== toHex(publicKey) ||
      account.address !==
        addressFor(account.chain, publicKey, account.path, account.scheme)
    )
      throw new ConnectError(
        ERROR_CODES.unauthorized,
        "The unlocked keystore does not match this account"
      );
    switch (request.method) {
      case "eth_signTransaction": {
        const tx = evmTransaction(request.params);
        tx.signature = new SigningKey(privateKey).sign(tx.unsignedHash);
        return tx.serialized;
      }
      case "personal_sign":
        return new SigningKey(privateKey).sign(
          hashMessage(fromHex(request.params.message))
        ).serialized;
      case "eth_signTypedData_v4": {
        const data = typedData(request.params);
        return new SigningKey(privateKey).sign(data.digest).serialized;
      }
      case "signAmino": {
        if (account.scheme === "eip712")
          throw new ConnectError(
            ERROR_CODES.unsupported,
            "Use native THORChain keystore accounts for Amino signing"
          );
        const signature = secp256k1
          .sign(
            sha256(new TextEncoder().encode(canonicalJson(request.params))),
            privateKey
          )
          .toBytes("compact");
        return {
          signed: request.params,
          signature: {
            pub_key: {
              type: "tendermint/PubKeySecp256k1",
              value: base64(publicKey),
            },
            signature: base64(signature),
          },
        };
      }
      case "signDirect": {
        const doc = SignDoc.fromPartial({
          bodyBytes: fromHex(request.params.bodyBytes),
          authInfoBytes: fromHex(request.params.authInfoBytes),
          chainId: request.params.chainId,
          accountNumber: BigInt(request.params.accountNumber),
        });
        const signature = secp256k1
          .sign(sha256(SignDoc.encode(doc).finish()), privateKey)
          .toBytes("compact");
        return {
          signed: request.params,
          signature: {
            pub_key: {
              type: "tendermint/PubKeySecp256k1",
              value: base64(publicKey),
            },
            signature: base64(signature),
          },
        };
      }
      case "signPsbt": {
        const psbt = validatePsbt(account, request);
        for (const index of request.params.inputs)
          psbt.signInput(
            index,
            {
              publicKey: Buffer.from(publicKey),
              sign: (hash) =>
                Buffer.from(
                  secp256k1.sign(hash, privateKey).toBytes("compact")
                ),
            },
            [Transaction.SIGHASH_ALL]
          );
        return { psbt: psbt.toBase64() };
      }
      case "signUtxoTransaction": {
        const tx = validateUtxo(account, request);
        for (const input of request.params.inputs) {
          const previous = previousOutput(
            tx,
            input.index,
            input.previousTransactionHex,
            input.value
          );
          const sighash =
            account.chain === "BCH" ? 0x41 : Transaction.SIGHASH_ALL;
          const segwit = account.path.startsWith("m/84'");
          const scriptCode = segwit
            ? payments.p2pkh({ pubkey: Buffer.from(publicKey) }).output
            : previous.script;
          if (!scriptCode)
            throw new ConnectError(ERROR_CODES.invalid, "Invalid public key");
          const hash =
            account.chain === "BCH" || segwit
              ? tx.hashForWitnessV0(
                  input.index,
                  scriptCode,
                  previous.value,
                  sighash
                )
              : tx.hashForSignature(input.index, previous.script, sighash);
          const signature = secp256k1.sign(hash, privateKey);
          const encoded = Buffer.concat([
            Buffer.from(signature.toBytes("der")),
            Buffer.from([sighash]),
          ]);
          if (segwit)
            tx.setWitness(input.index, [encoded, Buffer.from(publicKey)]);
          else
            tx.setInputScript(
              input.index,
              script.compile([encoded, Buffer.from(publicKey)])
            );
        }
        return { transactionHex: tx.toHex() };
      }
      case "signSolanaTransaction": {
        const tx = solanaTransaction(account, request.params.transaction);
        tx.sign([solanaKey(privateKey)]);
        return { transaction: base64(tx.serialize()) };
      }
      case "signSolanaMessage":
        return {
          signature: base64(
            ed25519.sign(fromHex(request.params.message), privateKey)
          ),
        };
      case "signXrpTransaction": {
        validate(request.params);
        const wallet = new Wallet(
          toHex(publicKey).toUpperCase(),
          toHex(privateKey).toUpperCase()
        );
        return wallet.sign(request.params as XrpTransaction);
      }
      case "signTronTransaction": {
        const native = validateTron(account, request.params);
        const signature = secp256k1.sign(
          sha256(fromHex(native.rawDataHex)),
          privateKey
        );
        return {
          ...request.params,
          signature: [
            toHex(signature.toBytes("compact")) +
              (signature.recovery + 27).toString(16).padStart(2, "0"),
          ],
        };
      }
    }
  } finally {
    privateKey.fill(0);
  }
}
