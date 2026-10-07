import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import { ConnectError, ERROR_CODES } from "@rujira/connect-core";

import { fromHex, toHex } from "./bytes";
import { privateKeyFor } from "./keys";

const ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BLOCK_LENGTHS = [0, 2, 3, 5, 6, 7, 9, 10, 11] as const;

function scalar(bytes: Uint8Array): bigint {
  return BigInt(`0x${toHex(new Uint8Array(bytes).reverse())}`) % ORDER;
}
function reduced(bytes: Uint8Array): Uint8Array {
  return fromHex(scalar(bytes).toString(16).padStart(64, "0")).reverse();
}
function moneroBase58(bytes: Uint8Array): string {
  let address = "";
  for (let offset = 0; offset < bytes.length; offset += 8) {
    const block = bytes.subarray(offset, offset + 8);
    let number = BigInt(`0x${toHex(block)}`);
    let encoded = "";
    while (number > 0n) {
      encoded = (ALPHABET[Number(number % 58n)] ?? "") + encoded;
      number /= 58n;
    }
    address += encoded.padStart(BLOCK_LENGTHS[block.length] ?? 0, "1");
  }
  return address;
}

export function moneroAddress(
  publicSpend: Uint8Array,
  publicView: Uint8Array
): string {
  if (publicSpend.length !== 32 || publicView.length !== 32)
    throw new ConnectError(
      ERROR_CODES.invalid,
      "The device returned invalid Monero public keys."
    );
  for (const key of [publicSpend, publicView])
    ed25519.Point.fromBytes(key).assertValidity();
  const payload = new Uint8Array([18, ...publicSpend, ...publicView]);
  return moneroBase58(
    new Uint8Array([...payload, ...keccak_256(payload).subarray(0, 4)])
  );
}

export function moneroPublicKeys(address: string): {
  publicSpend: Uint8Array;
  publicView: Uint8Array;
  publicKey: string;
} {
  const bytes: number[] = [];
  for (let offset = 0; offset < address.length; offset += 11) {
    const block = address.slice(offset, offset + 11);
    const length = BLOCK_LENGTHS.findIndex((size) => size === block.length);
    if (length < 1)
      throw new ConnectError(
        ERROR_CODES.invalid,
        "The device returned an invalid Monero address."
      );
    let value = 0n;
    for (const character of block) {
      const digit = ALPHABET.indexOf(character);
      if (digit < 0)
        throw new ConnectError(
          ERROR_CODES.invalid,
          "The device returned an invalid Monero address."
        );
      value = value * 58n + BigInt(digit);
    }
    if (value >= 1n << BigInt(length * 8))
      throw new ConnectError(
        ERROR_CODES.invalid,
        "The device returned an invalid Monero address."
      );
    bytes.push(...fromHex(value.toString(16).padStart(length * 2, "0")));
  }
  const publicSpend = new Uint8Array(bytes.slice(1, 33));
  const publicView = new Uint8Array(bytes.slice(33, 65));
  if (
    bytes.length !== 69 ||
    bytes[0] !== 18 ||
    moneroAddress(publicSpend, publicView) !== address
  )
    throw new ConnectError(
      ERROR_CODES.invalid,
      "The device returned an invalid mainnet Monero address."
    );
  return {
    publicSpend,
    publicView,
    publicKey: toHex(new Uint8Array([...publicSpend, ...publicView])),
  };
}

export function moneroKeys(
  seed: Uint8Array,
  path: string
): { spendKey: string; viewKey: string; address: string } {
  const spend = privateKeyFor(seed, "XMR", path);
  const view = reduced(keccak_256(spend));
  try {
    const publicSpend = ed25519.Point.BASE.multiply(scalar(spend)).toBytes();
    const publicView = ed25519.Point.BASE.multiply(scalar(view)).toBytes();
    return {
      spendKey: toHex(spend),
      viewKey: toHex(view),
      address: moneroAddress(publicSpend, publicView),
    };
  } finally {
    spend.fill(0);
    view.fill(0);
  }
}
