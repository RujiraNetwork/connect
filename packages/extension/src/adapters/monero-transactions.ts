import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  ConnectError,
  ERROR_CODES,
  canonicalJson,
  preparedMoneroTransactionSchema,
  signedMoneroTransactionSchema,
} from "@rujira/connect-core";
import { z } from "zod";

import { equalBytes, fromHex, toHex } from "./bytes";
import { moneroPublicKeys } from "./monero-keys";

import type {
  Account,
  PreparedMoneroTransaction,
  SignedMoneroTransaction,
} from "@rujira/connect-core";

const ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;
const key = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.string().regex(/^(?:[a-f0-9]{2})+$/);
const trezorResultSchema = z.object({
  signatures: z.array(bytes).min(1).max(32),
  tx_prefix_hash: key,
  rv: z.object({ txn_fee: z.number().int().safe(), rv_type: z.literal(6) }),
  opening_key: key,
  pseudo_outs: z.array(key).min(1).max(32),
  out_pks: z.array(bytes.length(128)).length(2),
  ecdh_infos: z.array(bytes.length(16)).length(2),
  tx_outs: z.array(bytes.length(70)).length(2),
  rsig_parts: z.array(bytes).length(1),
  extra: bytes.max(2048),
});

function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ConnectError(ERROR_CODES.invalid, message);
}

function point(key: string): void {
  const decoded = ed25519.Point.fromHex(key);
  decoded.assertValidity();
  ensure(
    !decoded.is0() && decoded.isTorsionFree(),
    "The prepared Monero transaction contains an invalid public key."
  );
}

export function validateMoneroTransaction(
  account: Account,
  transaction: PreparedMoneroTransaction
): void {
  ensure(
    account.chain === "XMR",
    "Select a registered Monero account for this transaction."
  );
  const prepared = preparedMoneroTransactionSchema.parse(transaction);
  const { inputs, keyImages, tsx_data: data } = prepared;
  ensure(
    inputs.length === data.num_inputs && inputs.length === keyImages.length,
    "The Monero input and key-image counts do not match."
  );
  const realOutputs = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    const image = keyImages[index];
    ensure(image !== undefined, "A Monero input is missing its key image.");
    point(image);
    const previousImage = keyImages[index - 1];
    ensure(
      previousImage === undefined || previousImage > image,
      "Monero inputs must have unique key images in descending byte order."
    );
    ensure(
      data.minor_indices.includes(input.subaddr_minor),
      "A Monero input's subaddress index is missing from the prepared data."
    );
    point(input.real_out_tx_key);
    for (const key of input.real_out_additional_tx_keys) point(key);
    const mask = BigInt(`0x${toHex(fromHex(input.mask).reverse())}`);
    ensure(mask < ORDER, "A Monero input has an invalid commitment mask.");
    for (const [index, output] of input.outputs.entries()) {
      point(output.key.dest);
      point(output.key.commitment);
      const previous = input.outputs[index - 1];
      ensure(
        previous === undefined || previous.idx < output.idx,
        "Monero ring members must have unique, increasing output indices."
      );
    }
    const real = input.outputs[input.real_output];
    ensure(real !== undefined, "A Monero input is missing its real output.");
    ensure(
      !realOutputs.has(real.key.dest),
      "The prepared Monero transaction spends the same output twice."
    );
    realOutputs.add(real.key.dest);
  }
  for (const output of [...data.outputs, data.change_dts]) {
    const decoded = moneroPublicKeys(output.original);
    ensure(
      toHex(decoded.publicSpend) === output.addr.spend_public_key &&
        toHex(decoded.publicView) === output.addr.view_public_key,
      "A Monero destination's address does not match its public keys."
    );
  }
  const change = data.change_dts;
  ensure(
    change.original === account.address &&
      `${change.addr.spend_public_key}${change.addr.view_public_key}` ===
        account.publicKey,
    "Monero change must return to the registered account."
  );
  ensure(
    data.outputs.filter(
      (output) => canonicalJson(output) === canonicalJson(change)
    ).length === 1,
    "The prepared Monero transaction must contain its change output exactly once."
  );
  ensure(
    recipient(prepared).amount > 0,
    "The Monero recipient amount must be greater than zero."
  );
  ensure(
    inputs.reduce((sum, input) => sum + BigInt(input.amount), 0n) ===
      data.outputs.reduce((sum, output) => sum + BigInt(output.amount), 0n) +
        BigInt(data.fee),
    "The Monero input amounts must cover the outputs and the exact fee."
  );
}

export function recipient(
  transaction: PreparedMoneroTransaction
): PreparedMoneroTransaction["tsx_data"]["outputs"][number] {
  const output = transaction.tsx_data.outputs.find(
    (output) =>
      canonicalJson(output) !== canonicalJson(transaction.tsx_data.change_dts)
  );
  ensure(output !== undefined, "The Monero transaction has no recipient.");
  return output;
}

export function join(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export function varint(value: number): Uint8Array {
  let remaining = BigInt(value);
  const bytes: number[] = [];
  do {
    const low = Number(remaining & 0x7fn);
    remaining >>= 7n;
    bytes.push(low | (remaining > 0n ? 0x80 : 0));
  } while (remaining > 0n);
  return new Uint8Array(bytes);
}

export function inputBytes(transaction: PreparedMoneroTransaction): Uint8Array {
  return join(
    varint(transaction.inputs.length),
    ...transaction.inputs.map((input, index) =>
      join(
        new Uint8Array([2, 0, 16]),
        ...input.outputs.map((output, index) =>
          varint(output.idx - (input.outputs[index - 1]?.idx ?? 0))
        ),
        fromHex(transaction.keyImages[index] ?? "")
      )
    )
  );
}

/** Trezor's offloading_keys._build_key: double Keccak over a fixed 48-byte buffer. */
function signatureKey(
  master: Uint8Array,
  index: number,
  iv: boolean
): Uint8Array {
  const buffer = new Uint8Array(48);
  buffer.set(master);
  buffer.set(new TextEncoder().encode(iv ? "sig-iv" : "sig-key"), 32);
  buffer.set(varint(index), 44);
  return keccak_256(keccak_256(buffer));
}

/** Serialize Monero v2 / RingCT Bulletproof+ from the device's native signing result. */
export function assembleMoneroTransaction(
  account: Account,
  transaction: PreparedMoneroTransaction,
  result: unknown
): SignedMoneroTransaction {
  validateMoneroTransaction(account, transaction);
  const signed = trezorResultSchema.parse(result);
  const count = transaction.inputs.length;
  ensure(
    signed.signatures.length === count &&
      signed.pseudo_outs.length === count &&
      signed.rv.txn_fee === transaction.tsx_data.fee,
    "The device returned a different Monero input count or fee."
  );
  for (const [index, output] of signed.tx_outs.entries()) {
    ensure(
      output.startsWith("0003"),
      "The device returned an unsupported Monero output."
    );
    point(output.slice(4, 68));
    ensure(
      signed.out_pks[index]?.startsWith(output.slice(4, 68)) === true,
      "The device's Monero output key does not match its commitment entry."
    );
  }
  const extra = fromHex(signed.extra);
  ensure(
    extra.length < 128,
    "The device returned unsupported Monero transaction metadata."
  );
  for (const output of signed.out_pks) point(output.slice(64));
  for (const output of signed.pseudo_outs) point(output);
  const prefix = join(
    new Uint8Array([2, 0]),
    inputBytes(transaction),
    varint(2),
    ...signed.tx_outs.map(fromHex),
    varint(extra.length),
    extra
  );
  ensure(
    toHex(keccak_256(prefix)) === signed.tx_prefix_hash,
    "The device's Monero transaction does not match the prepared inputs and key images."
  );
  const proof = fromHex(signed.rsig_parts[0] ?? "");
  // Two outputs need a 128-element Bulletproof+, with seven L and R points.
  ensure(
    proof.length === 642 && proof[192] === 7 && proof[417] === 7,
    "The device returned an unsupported Monero range proof."
  );
  const opening = fromHex(signed.opening_key);
  let signatures: Uint8Array[];
  try {
    signatures = signed.signatures.map((signature, index) => {
      const key = signatureKey(opening, index, false);
      try {
        const bytes = chacha20poly1305(
          key,
          signatureKey(opening, index, true).subarray(0, 12)
        ).decrypt(fromHex(signature));
        ensure(
          bytes.length === 577 && bytes[0] === 16,
          "The device returned an unsupported Monero ring signature."
        );
        // The device includes the ring-size varint; the transaction format omits it.
        return bytes.subarray(1);
      } finally {
        key.fill(0);
      }
    });
  } finally {
    opening.fill(0);
  }
  const base = join(
    new Uint8Array([6]),
    varint(transaction.tsx_data.fee),
    ...signed.ecdh_infos.map(fromHex),
    ...signed.out_pks.map((output) => fromHex(output.slice(64)))
  );
  const prunable = join(
    new Uint8Array([1]),
    proof,
    ...signatures,
    ...signed.pseudo_outs.map(fromHex)
  );
  return {
    transactionHex: toHex(join(prefix, base, prunable)),
    transactionHash: transactionHash(prefix, base, prunable),
    fee: String(transaction.tsx_data.fee),
    amount: String(recipient(transaction).amount),
  };
}

export function transactionHash(
  prefix: Uint8Array,
  base: Uint8Array,
  prunable: Uint8Array
): string {
  return toHex(
    keccak_256(join(keccak_256(prefix), keccak_256(base), keccak_256(prunable)))
  );
}

/** Check the returned bytes against the approved inputs, fee, and transaction hash. */
export function verifyMoneroTransaction(
  account: Account,
  transaction: PreparedMoneroTransaction,
  result: unknown
): void {
  validateMoneroTransaction(account, transaction);
  const signed = signedMoneroTransactionSchema.parse(result);
  const bytes = fromHex(signed.transactionHex);
  const expected = join(
    new Uint8Array([2, 0]),
    inputBytes(transaction),
    new Uint8Array([2])
  );
  ensure(
    equalBytes(bytes.subarray(0, expected.length), expected),
    "The signed Monero inputs changed."
  );
  const outputsEnd = expected.length + 70;
  const extraLength = bytes[outputsEnd];
  // For this two-output format the device's extra fits in a one-byte varint.
  ensure(
    extraLength !== undefined && extraLength < 128,
    "The signed Monero extra is unsupported."
  );
  const prefixEnd = outputsEnd + 1 + extraLength;
  const expectedBase = join(
    new Uint8Array([6]),
    varint(transaction.tsx_data.fee)
  );
  ensure(
    equalBytes(
      bytes.subarray(prefixEnd, prefixEnd + expectedBase.length),
      expectedBase
    ),
    "The signed Monero fee changed."
  );
  const baseEnd = prefixEnd + expectedBase.length + 80;
  const prunable = bytes.subarray(baseEnd);
  ensure(
    prunable.length === 643 + transaction.inputs.length * 608 &&
      prunable[0] === 1 &&
      signed.fee === String(transaction.tsx_data.fee) &&
      signed.amount === String(recipient(transaction).amount) &&
      signed.transactionHash ===
        transactionHash(
          bytes.subarray(0, prefixEnd),
          bytes.subarray(prefixEnd, baseEnd),
          prunable
        ),
    "The signed Monero transaction hash or signing result changed."
  );
}
