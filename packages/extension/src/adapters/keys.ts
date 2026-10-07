import { Buffer } from "buffer";

import { ed25519 } from "@noble/curves/ed25519";
import { ripemd160 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { CHAINS } from "@rujira/connect-core";
import { base58, bech32 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { payments, networks } from "bitcoinjs-lib";
import cashaddr from "cashaddrjs";
import { derivePath } from "ed25519-hd-key";
import { computeAddress, getBytes, SigningKey } from "ethers";
import slip10 from "micro-key-producer/slip10.js";
import { TronWeb } from "tronweb";
import { deriveAddress } from "xrpl";

import { toHex } from "./bytes";

import type { Chain } from "@rujira/connect-core";
import type { Network } from "bitcoinjs-lib";

export function utxoNetwork(chain: Chain): Network {
  if (chain === "BTC" || chain === "BCH") return networks.bitcoin;
  if (chain === "LTC")
    return {
      messagePrefix: "\x19Litecoin Signed Message:\n",
      bech32: "ltc",
      bip32: { public: 0x019da462, private: 0x019d9cfe },
      pubKeyHash: 0x30,
      scriptHash: 0x32,
      wif: 0xb0,
    };
  if (chain === "DOGE")
    return {
      messagePrefix: "\x19Dogecoin Signed Message:\n",
      bech32: "doge",
      bip32: { public: 0x02facafd, private: 0x02fac398 },
      pubKeyHash: 0x1e,
      scriptHash: 0x16,
      wif: 0x9e,
    };
  throw new Error("Not a UTXO network");
}

export function privateKeyFor(
  seed: Uint8Array,
  chain: Chain,
  path: string
): Uint8Array<ArrayBuffer> {
  if (chain === "SOL") return new Uint8Array(derivePath(path, toHex(seed)).key);
  if (chain === "XMR") {
    const derived = slip10.fromMasterSeed(seed).derive(path).privateKey;
    const order = 2n ** 252n + 27742317777372353535851937790883648493n;
    const scalar =
      BigInt(`0x${toHex(new Uint8Array(derived).reverse())}`) % order;
    return new Uint8Array(
      Buffer.from(scalar.toString(16).padStart(64, "0"), "hex").reverse()
    );
  }
  const key = HDKey.fromMasterSeed(seed).derive(path).privateKey;
  if (!key) throw new Error("Cannot derive the private key");
  return new Uint8Array(key);
}

export function publicKeyFor(privateKey: Uint8Array, chain: Chain): Uint8Array {
  return chain === "SOL"
    ? ed25519.getPublicKey(privateKey)
    : getBytes(SigningKey.computePublicKey(privateKey, true));
}

export function addressFor(
  chain: Chain,
  publicKey: Uint8Array,
  path: string,
  scheme: "native" | "eip712" = "native"
): string {
  if (CHAINS[chain].family === "evm")
    return computeAddress(`0x${toHex(publicKey)}`);
  if (chain === "THOR" && scheme === "eip712")
    return bech32.encode(
      "thor",
      bech32.toWords(getBytes(computeAddress(`0x${toHex(publicKey)}`)))
    );
  if (chain === "THOR" || chain === "GAIA")
    return bech32.encode(
      chain === "THOR" ? "thor" : "cosmos",
      bech32.toWords(ripemd160(sha256(publicKey)))
    );
  if (chain === "XRP") return deriveAddress(toHex(publicKey).toUpperCase());
  if (chain === "TRON") {
    const uncompressed = getBytes(
      SigningKey.computePublicKey(publicKey, false)
    );
    const hash = keccak_256(uncompressed.subarray(1));
    return TronWeb.address.fromHex(`41${toHex(hash.subarray(12))}`);
  }
  if (chain === "SOL") return base58.encode(publicKey);
  if (chain === "XMR")
    throw new Error("Monero addresses are registered through the companion");
  if (chain === "BCH")
    return cashaddr.encode(
      "bitcoincash",
      "P2PKH",
      ripemd160(sha256(publicKey))
    );
  const payment = path.startsWith("m/84'")
    ? payments.p2wpkh({
        pubkey: Buffer.from(publicKey),
        network: utxoNetwork(chain),
      })
    : payments.p2pkh({
        pubkey: Buffer.from(publicKey),
        network: utxoNetwork(chain),
      });
  if (!payment.address) throw new Error("Cannot derive the address");
  return payment.address;
}
