import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import { ConnectError, ERROR_CODES, canonicalJson } from "@rujira/connect-core";

import { fromHex, toHex } from "./bytes";
import {
  assertMoneroBytes,
  finishMonero,
  hashPoint,
  hashScalar,
  MONERO_ORDER,
  moneroBase,
  moneroCommitment,
  moneroPrefix,
  moneroSigningHash,
  proveMonero,
  randomScalar,
  scalarBytes,
  scalarValue,
  wipeMoneroKernel,
} from "./monero-crypto";
import { join, validateMoneroTransaction, varint } from "./monero-transactions";

import type {
  Account,
  PreparedMoneroTransaction,
  SignedMoneroTransaction,
} from "@rujira/connect-core";

export type MoneroExchange = (
  apdu: Uint8Array,
  timeout?: number
) => Promise<Uint8Array>;

function word(value: number, littleEndian = false): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, littleEndian);
  return bytes;
}
function sized(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length !== length)
    throw new ConnectError(
      ERROR_CODES.invalid,
      "Ledger returned incomplete Monero signing data."
    );
  return bytes;
}
function multiply(
  point: typeof ed25519.Point.BASE,
  scalar: bigint
): typeof ed25519.Point.BASE {
  const value = scalar % MONERO_ORDER;
  return value === 0n ? ed25519.Point.ZERO : point.multiply(value);
}

/** Protocol v4: opaque device secret + HMAC handles never leave this session. */
export async function signLedgerMonero(
  account: Account,
  transaction: PreparedMoneroTransaction,
  exchange: MoneroExchange
): Promise<SignedMoneroTransaction> {
  validateMoneroTransaction(account, transaction);
  const handles: Uint8Array[] = [];
  const masks: Uint8Array[] = [];
  const pseudoMasks: Uint8Array[] = [];
  const command = async (
    ins: number,
    p1 = 0,
    p2 = 0,
    data: Uint8Array = new Uint8Array(),
    options = 0,
    confirm = false
  ): Promise<Uint8Array> => {
    if (data.length > 254)
      throw new ConnectError(
        ERROR_CODES.invalid,
        "The Ledger Monero command is too large."
      );
    return exchange(
      join(new Uint8Array([4, ins, p1, p2, data.length + 1, options]), data),
      confirm ? 290_000 : 10_000
    );
  };
  let opened = false;
  let succeeded = false;
  try {
    await command(0x72, 0, 0, new Uint8Array([1]));
    opened = true;
    const openedTx = sized(await command(0x70, 1, 0, word(0)), 224);
    const publicKey = openedTx.slice(0, 32);
    const txSecret = openedTx.slice(32, 96);
    const viewSecret = openedTx.slice(96, 160);
    const spendSecret = openedTx.slice(160, 224);
    handles.push(txSecret, viewSecret, spendSecret, openedTx);
    const inputSecrets: Uint8Array[] = [];
    for (const [index, input] of transaction.inputs.entries()) {
      const real = input.outputs[input.real_output];
      if (!real)
        throw new ConnectError(
          ERROR_CODES.invalid,
          "A Monero ring has no real output."
        );
      const expectedCommitment = moneroCommitment(
        fromHex(input.mask),
        input.amount
      );
      assertMoneroBytes(
        expectedCommitment,
        fromHex(real.key.commitment),
        "The real Monero output's amount and mask do not match its commitment."
      );
      const candidates = [input.real_out_tx_key];
      const additional =
        input.real_out_additional_tx_keys[input.real_output_in_tx_index];
      if (additional) candidates.push(additional);
      let oneTimeSecret: Uint8Array | undefined;
      for (const key of candidates) {
        const derivation = sized(
          await command(0x32, 0, 0, join(fromHex(key), viewSecret)),
          64
        );
        handles.push(derivation);
        let derived = sized(
          await command(
            0x38,
            0,
            0,
            join(derivation, word(input.real_output_in_tx_index), spendSecret)
          ),
          64
        );
        handles.push(derived);
        if (input.subaddr_minor !== 0) {
          const subaddress = sized(
            await command(
              0x4c,
              0,
              0,
              join(viewSecret, word(0, true), word(input.subaddr_minor, true))
            ),
            64
          );
          handles.push(subaddress);
          derived = sized(
            await command(0x3c, 0, 0, join(derived, subaddress)),
            64
          );
          handles.push(derived);
        }
        const actualPublic = sized(await command(0x30, 0, 0, derived), 32);
        if (toHex(actualPublic) === real.key.dest) {
          oneTimeSecret = derived;
          break;
        }
      }
      if (!oneTimeSecret)
        throw new ConnectError(
          ERROR_CODES.unauthorized,
          "A prepared Monero input does not belong to this Ledger."
        );
      const image = sized(
        await command(0x3a, 0, 0, join(fromHex(real.key.dest), oneTimeSecret)),
        32
      );
      assertMoneroBytes(
        image,
        fromHex(transaction.keyImages[index] ?? ""),
        "The prepared Monero key image does not match this Ledger."
      );
      inputSecrets.push(oneTimeSecret);
    }
    const outputs: Uint8Array[] = [];
    const amountKeys: Uint8Array[] = [];
    for (const [index, output] of transaction.tsx_data.outputs.entries()) {
      const change =
        canonicalJson(output) ===
        canonicalJson(transaction.tsx_data.change_dts);
      const keys = sized(
        await command(
          0x7b,
          0,
          0,
          join(
            word(2),
            txSecret,
            publicKey,
            fromHex(output.addr.view_public_key),
            fromHex(output.addr.spend_public_key),
            word(index),
            new Uint8Array([Number(change), 0, 0]),
            new Uint8Array(32),
            new Uint8Array([1])
          )
        ),
        97
      );
      const amountKey = keys.slice(0, 64);
      handles.push(amountKey, keys);
      amountKeys.push(amountKey);
      outputs.push(
        join(new Uint8Array([0, 3]), keys.slice(64, 96), keys.slice(96))
      );
    }
    const prefix = moneroPrefix(transaction, outputs, publicKey);
    await command(0x7d, 1, 0, prefix.slice(0, 2), 0, true);
    for (
      let offset = 2, chunk = 1;
      offset < prefix.length;
      offset += 240, chunk++
    ) {
      const last = offset + 240 >= prefix.length;
      const hash = await command(
        0x7d,
        2,
        chunk,
        prefix.slice(offset, offset + 240),
        last ? 0 : 0x80
      );
      if (last)
        assertMoneroBytes(
          hash,
          keccak_256(prefix),
          "Ledger signed a different Monero transaction prefix."
        );
    }
    // The app state machine requires every mask before the first BLIND command.
    for (const key of amountKeys)
      masks.push(sized(await command(0x77, 0, 0, key), 32));
    const encrypted: Uint8Array[] = [];
    for (const [index, output] of transaction.tsx_data.outputs.entries()) {
      const key = amountKeys[index];
      const mask = masks[index];
      if (!key || !mask)
        throw new ConnectError(
          ERROR_CODES.invalid,
          "Missing Monero output data."
        );
      const blind = sized(
        await command(
          0x78,
          0,
          0,
          join(key, mask, scalarBytes(BigInt(output.amount))),
          2
        ),
        64
      );
      encrypted.push(blind.slice(0, 8));
    }
    const proof = proveMonero(
      transaction.tsx_data.outputs.map((output) => output.amount),
      masks
    );
    const base = moneroBase(transaction, encrypted, proof.commitments);
    await command(
      0x7c,
      1,
      1,
      join(new Uint8Array([6]), varint(transaction.tsx_data.fee)),
      0x80,
      true
    );
    for (const [index, output] of transaction.tsx_data.outputs.entries()) {
      const key = amountKeys[index];
      const encryptedAmount = encrypted[index];
      const commitment = proof.commitments[index];
      if (!key || !encryptedAmount || !commitment)
        throw new ConnectError(
          ERROR_CODES.invalid,
          "Missing Monero commitment data."
        );
      const change =
        canonicalJson(output) ===
        canonicalJson(transaction.tsx_data.change_dts);
      await command(
        0x7c,
        2,
        index + 1,
        join(
          new Uint8Array([0, Number(change)]),
          fromHex(output.addr.view_public_key),
          fromHex(output.addr.spend_public_key),
          key,
          fromHex(commitment),
          new Uint8Array(32),
          join(encryptedAmount, new Uint8Array(24))
        ),
        (index === 1 ? 0 : 0x80) | 2,
        true
      );
    }
    for (const [index, commitment] of proof.commitments.entries())
      await command(0x7c, 3, index + 1, fromHex(commitment), 0x80);
    const message = moneroSigningHash(prefix, base, proof.proofHash);
    assertMoneroBytes(
      await command(
        0x7c,
        3,
        3,
        join(keccak_256(prefix), fromHex(proof.proofHash))
      ),
      message,
      "Ledger's Monero signing hash does not match the approved transaction."
    );
    const totalMask = masks.reduce((sum, mask) => sum + scalarValue(mask), 0n);
    let pseudoSum = 0n;
    const signatures: Uint8Array[] = [];
    const pseudoOuts: Uint8Array[] = [];
    for (const [index, input] of transaction.inputs.entries()) {
      const secret = inputSecrets[index];
      const real = input.outputs[input.real_output];
      if (!secret || !real)
        throw new ConnectError(
          ERROR_CODES.invalid,
          "Missing Monero input signing data."
        );
      const mask =
        index === transaction.inputs.length - 1
          ? scalarBytes(totalMask - pseudoSum)
          : randomScalar();
      pseudoMasks.push(mask);
      pseudoSum += scalarValue(mask);
      const pseudo = moneroCommitment(mask, input.amount);
      pseudoOuts.push(pseudo);
      const delta = scalarBytes(
        scalarValue(fromHex(input.mask)) - scalarValue(mask)
      );
      pseudoMasks.push(delta);
      const prepared = sized(
        await command(
          0x7f,
          1,
          0,
          join(secret, delta, hashPoint(real.key.dest))
        ),
        192
      );
      handles.push(prepared);
      const alpha = prepared.slice(0, 64);
      handles.push(alpha);
      assertMoneroBytes(
        prepared.slice(128, 160),
        fromHex(transaction.keyImages[index] ?? ""),
        "Ledger returned a different Monero key image."
      );
      assertMoneroBytes(
        prepared.slice(160),
        multiply(
          ed25519.Point.fromBytes(hashPoint(real.key.dest)),
          scalarValue(delta)
        ).toBytes(),
        "Ledger returned a different Monero commitment image."
      );
      const clsag = clsagRound(
        input,
        pseudo,
        fromHex(transaction.keyImages[index] ?? ""),
        prepared.slice(160),
        prepared.slice(64, 96),
        prepared.slice(96, 128),
        message
      );
      let deviceChallenge: Uint8Array = new Uint8Array();
      for (
        let offset = 0, part = 1;
        offset < clsag.transcript.length;
        offset += 32, part++
      )
        deviceChallenge = await command(
          0x7f,
          2,
          part,
          clsag.transcript.slice(offset, offset + 32),
          offset + 32 === clsag.transcript.length ? 0 : 0x80
        );
      assertMoneroBytes(
        deviceChallenge,
        clsag.challenge,
        "Ledger returned a different Monero ring challenge."
      );
      const response = sized(
        await command(
          0x7f,
          3,
          0,
          join(alpha, secret, delta, clsag.muP, clsag.muC)
        ),
        32
      );
      clsag.responses[input.real_output] = response;
      signatures.push(join(...clsag.responses, clsag.c1, clsag.image));
    }
    const signed = finishMonero(
      account,
      transaction,
      prefix,
      base,
      proof.proof,
      signatures,
      pseudoOuts
    );
    succeeded = true;
    return signed;
  } finally {
    try {
      if (opened) {
        await command(0x80).catch((error: unknown) => {
          if (succeeded) throw error;
        });
      }
    } finally {
      for (const bytes of [...handles, ...masks, ...pseudoMasks]) bytes.fill(0);
      wipeMoneroKernel();
    }
  }
}

function clsagRound(
  input: PreparedMoneroTransaction["inputs"][number],
  pseudo: Uint8Array,
  keyImage: Uint8Array,
  fullImage: Uint8Array,
  nonceG: Uint8Array,
  nonceH: Uint8Array,
  message: Uint8Array
): {
  responses: Uint8Array[];
  c1: Uint8Array;
  image: Uint8Array;
  muP: Uint8Array;
  muC: Uint8Array;
  challenge: Uint8Array;
  transcript: Uint8Array;
} {
  const domain = (name: string): Uint8Array => {
    const bytes = new Uint8Array(32);
    bytes.set(new TextEncoder().encode(name));
    return bytes;
  };
  // The canonical inverse of eight modulo the Ed25519 scalar order.
  const inverse = (3n * MONERO_ORDER + 1n) / 8n;
  const image = multiply(ed25519.Point.fromBytes(fullImage), inverse).toBytes();
  const pubs = input.outputs.map((output) => fromHex(output.key.dest));
  const commitments = input.outputs.map((output) =>
    fromHex(output.key.commitment)
  );
  const aggregation = join(...pubs, ...commitments, keyImage, image, pseudo);
  const muP = hashScalar(join(domain("CLSAG_agg_0"), aggregation));
  const muC = hashScalar(join(domain("CLSAG_agg_1"), aggregation));
  const round = join(
    domain("CLSAG_round"),
    ...pubs,
    ...commitments,
    pseudo,
    message
  );
  const responses = input.outputs.map(() => randomScalar());
  let transcript = join(round, nonceG, nonceH);
  let challenge = hashScalar(transcript);
  let c1 = input.real_output === 15 ? challenge : undefined;
  const combinedImage = multiply(
    ed25519.Point.fromBytes(keyImage),
    scalarValue(muP)
  ).add(multiply(ed25519.Point.fromBytes(fullImage), scalarValue(muC)));
  for (let offset = 1; offset < 16; offset++) {
    const index = (input.real_output + offset) % 16;
    if (index === 0) c1 = challenge;
    const output = input.outputs[index];
    const response = responses[index];
    if (!output || !response) throw new Error("Incomplete Monero ring");
    const publicKey = ed25519.Point.fromHex(output.key.dest);
    const commitment = ed25519.Point.fromHex(output.key.commitment).subtract(
      ed25519.Point.fromBytes(pseudo)
    );
    const c = scalarValue(challenge);
    const left = multiply(ed25519.Point.BASE, scalarValue(response))
      .add(multiply(publicKey, c * scalarValue(muP)))
      .add(multiply(commitment, c * scalarValue(muC)));
    const right = multiply(
      ed25519.Point.fromBytes(hashPoint(output.key.dest)),
      scalarValue(response)
    ).add(multiply(combinedImage, c));
    transcript = join(round, left.toBytes(), right.toBytes());
    challenge = hashScalar(transcript);
  }
  if (input.real_output === 0) c1 = challenge;
  if (!c1) throw new Error("Missing Monero initial challenge");
  return { responses, c1, image, muP, muC, challenge, transcript };
}
