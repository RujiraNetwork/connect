import { Buffer } from "buffer";

import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  ConnectError,
  ERROR_CODES,
  signedMoneroTransactionSchema,
} from "@rujira/connect-core";
import { z } from "zod";

import { equalBytes, fromHex, toHex } from "./bytes";
import {
  initSync,
  commitment,
  hash_point,
  prove,
  software_images,
  software_output,
  software_sign,
  verify_transaction,
  wipe,
} from "./monero-kernel/kernel";
import kernelBytes from "./monero-kernel/kernel.base64?raw";
import { moneroPrivateKeys } from "./monero-keys";
import {
  inputBytes,
  join,
  recipient,
  transactionHash,
  validateMoneroTransaction,
  varint,
} from "./monero-transactions";

import type {
  Account,
  PreparedMoneroTransaction,
  SignedMoneroTransaction,
} from "@rujira/connect-core";

const hexKey = z.string().regex(/^[a-f0-9]{64}$/);
const proofSchema = z.object({
  proof: z.string().length(1284),
  proofHash: hexKey,
  commitments: z.array(hexKey).length(2),
});
const signatureSchema = z.object({
  signatures: z.array(z.string().length(1152)).min(1).max(32),
  pseudoOuts: z.array(hexKey).min(1).max(32),
});
let initialized = false;
export const MONERO_ORDER =
  2n ** 252n + 27742317777372353535851937790883648493n;

function initialize(): void {
  if (!initialized) {
    initSync({ module: Buffer.from(kernelBytes.trim(), "base64") });
    initialized = true;
  }
}
export function wipeMoneroKernel(): void {
  wipe();
  initialized = false;
}
export function randomScalar(): Uint8Array {
  // Wide reduction of 512 CSPRNG bits, matching Monero's scalar sampling.
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  try {
    return scalarBytes(BigInt(`0x${toHex(bytes.reverse())}`));
  } finally {
    bytes.fill(0);
  }
}
export function scalarValue(bytes: Uint8Array): bigint {
  return BigInt(`0x${toHex(new Uint8Array(bytes).reverse())}`);
}
export function scalarBytes(value: bigint): Uint8Array {
  const reduced = ((value % MONERO_ORDER) + MONERO_ORDER) % MONERO_ORDER;
  return fromHex(reduced.toString(16).padStart(64, "0")).reverse();
}
export function hashScalar(bytes: Uint8Array): Uint8Array {
  return scalarBytes(scalarValue(keccak_256(bytes)));
}
export function hashPoint(key: string): Uint8Array {
  initialize();
  return fromHex(hash_point(key));
}
export function moneroCommitment(mask: Uint8Array, amount: number): Uint8Array {
  initialize();
  return fromHex(commitment(toHex(mask), String(amount)));
}
export function proveMonero(
  amounts: number[],
  masks: Uint8Array[]
): z.infer<typeof proofSchema> {
  initialize();
  const seed = crypto.getRandomValues(new Uint8Array(32));
  try {
    return proofSchema.parse(
      JSON.parse(
        prove(JSON.stringify(amounts), JSON.stringify(masks.map(toHex)), seed)
      )
    );
  } finally {
    seed.fill(0);
  }
}
export function moneroPrefix(
  transaction: PreparedMoneroTransaction,
  outputs: Uint8Array[],
  publicKey: Uint8Array
): Uint8Array {
  const extra = join(new Uint8Array([1]), publicKey);
  return join(
    new Uint8Array([2, 0]),
    inputBytes(transaction),
    varint(2),
    ...outputs,
    varint(extra.length),
    extra
  );
}
export function moneroBase(
  transaction: PreparedMoneroTransaction,
  encryptedAmounts: Uint8Array[],
  commitments: string[]
): Uint8Array {
  return join(
    new Uint8Array([6]),
    varint(transaction.tsx_data.fee),
    ...encryptedAmounts,
    ...commitments.map(fromHex)
  );
}
export function moneroSigningHash(
  prefix: Uint8Array,
  base: Uint8Array,
  proofHash: string
): Uint8Array {
  return keccak_256(
    join(keccak_256(prefix), keccak_256(base), fromHex(proofHash))
  );
}
export function finishMonero(
  account: Account,
  transaction: PreparedMoneroTransaction,
  prefix: Uint8Array,
  base: Uint8Array,
  proof: string,
  signatures: Uint8Array[],
  pseudoOuts: Uint8Array[]
): SignedMoneroTransaction {
  const prunable = join(
    new Uint8Array([1]),
    fromHex(proof),
    ...signatures,
    ...pseudoOuts
  );
  const bytes = join(prefix, base, prunable);
  const hash = transactionHash(prefix, base, prunable);
  verifyMoneroCryptography(transaction, {
    transactionHex: toHex(bytes),
    transactionHash: hash,
    amount: String(recipient(transaction).amount),
    fee: String(transaction.tsx_data.fee),
  });
  validateMoneroTransaction(account, transaction);
  return {
    transactionHex: toHex(bytes),
    transactionHash: hash,
    amount: String(recipient(transaction).amount),
    fee: String(transaction.tsx_data.fee),
  };
}

/** Verifies native BP+, every CLSAG/key image and commitment balance locally. */
export function verifyMoneroCryptography(
  transaction: PreparedMoneroTransaction,
  result: unknown
): void {
  const signed = signedMoneroTransactionSchema.parse(result);
  const seed = crypto.getRandomValues(new Uint8Array(32));
  try {
    initialize();
    if (
      verify_transaction(
        fromHex(signed.transactionHex),
        JSON.stringify(transaction.inputs),
        seed
      ) !== signed.transactionHash
    )
      throw new Error("Hash mismatch");
  } catch {
    throw new ConnectError(
      ERROR_CODES.invalid,
      "The Monero transaction failed its proof or signature check. Nothing has been sent."
    );
  } finally {
    seed.fill(0);
  }
}

export function signMoneroSoftware(
  seed: Uint8Array,
  account: Account,
  transaction: PreparedMoneroTransaction
): SignedMoneroTransaction {
  validateMoneroTransaction(account, transaction);
  const keys = moneroPrivateKeys(seed, account.path);
  const { spend, view } = keys;
  let secret: Uint8Array = new Uint8Array(0);
  let entropy: Uint8Array = new Uint8Array(0);
  try {
    if (keys.address !== account.address)
      throw new ConnectError(
        ERROR_CODES.unauthorized,
        "The unlocked keystore does not match this Monero account."
      );
    secret = randomScalar();
    entropy = crypto.getRandomValues(new Uint8Array(32));
    initialize();
    const inputs = JSON.stringify(transaction.inputs);
    const images = z
      .array(hexKey)
      .parse(JSON.parse(software_images(spend, view, inputs)));
    if (images.some((image, index) => image !== transaction.keyImages[index]))
      throw new ConnectError(
        ERROR_CODES.invalid,
        "A prepared Monero key image does not belong to this keystore."
      );
    const outputs = transaction.tsx_data.outputs.map((output, index) =>
      software_output(
        secret,
        output.addr.view_public_key,
        output.addr.spend_public_key,
        index,
        String(output.amount)
      )
    );
    const masks = outputs.map((output) => output.slice(35, 67));
    const proof = proveMonero(
      transaction.tsx_data.outputs.map((output) => output.amount),
      masks
    );
    const prefix = moneroPrefix(
      transaction,
      outputs.map((output) => output.slice(0, 35)),
      ed25519.Point.BASE.multiply(scalarValue(secret)).toBytes()
    );
    const base = moneroBase(
      transaction,
      outputs.map((output) => output.slice(67, 75)),
      proof.commitments
    );
    const sum = scalarBytes(
      masks.reduce((sum, mask) => sum + scalarValue(mask), 0n)
    );
    const signed = signatureSchema.parse(
      JSON.parse(
        software_sign(
          spend,
          view,
          inputs,
          toHex(sum),
          toHex(moneroSigningHash(prefix, base, proof.proofHash)),
          entropy
        )
      )
    );
    if (
      signed.signatures.length !== transaction.inputs.length ||
      signed.pseudoOuts.length !== transaction.inputs.length
    )
      throw new ConnectError(
        ERROR_CODES.invalid,
        "The Monero signature count changed."
      );
    return finishMonero(
      account,
      transaction,
      prefix,
      base,
      proof.proof,
      signed.signatures.map(fromHex),
      signed.pseudoOuts.map(fromHex)
    );
  } finally {
    spend.fill(0);
    view.fill(0);
    secret.fill(0);
    entropy.fill(0);
    wipeMoneroKernel();
  }
}

export function assertMoneroBytes(
  actual: Uint8Array,
  expected: Uint8Array,
  message: string
): void {
  if (!equalBytes(actual, expected))
    throw new ConnectError(ERROR_CODES.invalid, message);
}
