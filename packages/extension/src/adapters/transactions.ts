import { Buffer } from "buffer";

import { ConnectError, ERROR_CODES } from "@rujira/connect-core";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { Psbt, Transaction, payments } from "bitcoinjs-lib";
import {
  Transaction as EthersTransaction,
  TypedDataEncoder,
  concat,
  keccak256,
} from "ethers";
import { TronWeb, utils as tronUtils } from "tronweb";
import { z } from "zod";

import { fromHex, toHex, unbase64 } from "./bytes";
import { utxoNetwork } from "./keys";

import type {
  Account,
  Chain,
  EvmTransaction,
  SignRequest,
} from "@rujira/connect-core";

export function evmTransaction(params: EvmTransaction): EthersTransaction {
  return EthersTransaction.from({
    chainId: BigInt(params.chainId),
    nonce: params.nonce,
    gasLimit: BigInt(params.gasLimit),
    value: BigInt(params.value ?? "0"),
    data: `0x${toHex(fromHex(params.data ?? ""))}`,
    ...(params.to === undefined ? {} : { to: params.to }),
    ...(params.gasPrice === undefined
      ? {}
      : { gasPrice: BigInt(params.gasPrice) }),
    ...(params.maxFeePerGas === undefined
      ? {}
      : { maxFeePerGas: BigInt(params.maxFeePerGas) }),
    ...(params.maxPriorityFeePerGas === undefined
      ? {}
      : { maxPriorityFeePerGas: BigInt(params.maxPriorityFeePerGas) }),
    type:
      params.type ??
      (params.maxFeePerGas !== undefined ||
      params.maxPriorityFeePerGas !== undefined
        ? 2
        : params.accessList !== undefined
          ? 1
          : 0),
    ...(params.accessList === undefined
      ? {}
      : { accessList: params.accessList }),
  });
}

export function typedData(
  params: Extract<SignRequest, { method: "eth_signTypedData_v4" }>["params"]
): {
  domain: Record<string, unknown>;
  digest: string;
  types: Record<string, { name: string; type: string }[]> & {
    EIP712Domain: { name: string; type: string }[];
  };
  message: Record<string, unknown>;
  primaryType: string;
} {
  const domainSchema = z
    .object({
      name: z.string().optional(),
      version: z.string().optional(),
      chainId: z.union([z.string(), z.number().int().safe()]).optional(),
      verifyingContract: z.string().optional(),
      salt: z.string().optional(),
    })
    .strict();
  const parsed = domainSchema.parse(params.domain);
  const domain: Record<string, unknown> = { ...parsed };
  const messageTypes = Object.fromEntries(
    Object.entries(params.types).filter(([name]) => name !== "EIP712Domain")
  );
  const domainTypes =
    params.types.EIP712Domain ??
    Object.keys(domain).map((name) => ({
      name,
      type:
        name === "chainId"
          ? "uint256"
          : name === "verifyingContract"
            ? "address"
            : name === "salt"
              ? "bytes32"
              : "string",
    }));
  const types = { ...messageTypes, EIP712Domain: domainTypes };
  const primaryType = TypedDataEncoder.getPrimaryType(messageTypes);
  if (params.primaryType !== undefined && params.primaryType !== primaryType)
    throw new ConnectError(
      ERROR_CODES.invalid,
      "Typed-data primary type does not match its schema"
    );
  validateTypedFields("EIP712Domain", domain, types);
  validateTypedFields(primaryType, params.message, types);
  const domainHash = TypedDataEncoder.from({ EIP712Domain: domainTypes }).hash(
    domain
  );
  const messageHash = TypedDataEncoder.from(messageTypes).hash(params.message);
  const digest = keccak256(concat(["0x1901", domainHash, messageHash]));
  return { domain, types, message: params.message, primaryType, digest };
}

export function validateTypedFields(
  type: string,
  value: unknown,
  types: Record<string, { name: string; type: string }[]>,
  depth = 0
): void {
  if (depth > 32)
    throw new ConnectError(
      ERROR_CODES.invalid,
      "Typed-data nesting is too deep"
    );
  const array = /^(.*)\[\d*\]$/.exec(type);
  if (array) {
    if (!Array.isArray(value))
      throw new ConnectError(ERROR_CODES.invalid, "Invalid typed-data array");
    for (const entry of value as unknown[])
      validateTypedFields(array[1] ?? "", entry, types, depth + 1);
    return;
  }
  const fields = types[type];
  if (!fields) return;
  const object = z.record(z.unknown()).parse(value);
  if (
    fields.length !== Object.keys(object).length ||
    new Set(fields.map((field) => field.name)).size !== fields.length ||
    fields.some((field) => !(field.name in object))
  )
    throw new ConnectError(
      ERROR_CODES.invalid,
      "Typed-data schema omitted approved fields"
    );
  for (const field of fields)
    validateTypedFields(field.type, object[field.name], types, depth + 1);
}

export function ownedScript(account: Account): Buffer {
  if (!account.publicKey)
    throw new ConnectError(
      ERROR_CODES.invalid,
      "This account has no verified public key"
    );
  const pubkey = Buffer.from(fromHex(account.publicKey));
  const output = account.path.startsWith("m/84'")
    ? payments.p2wpkh({ pubkey, network: utxoNetwork(account.chain) }).output
    : payments.p2pkh({ pubkey, network: utxoNetwork(account.chain) }).output;
  if (!output)
    throw new ConnectError(ERROR_CODES.invalid, "Invalid UTXO public key");
  return output;
}

export function previousOutput(
  transaction: Transaction,
  index: number,
  previousHex: string,
  declaredValue: string
): { script: Buffer; value: number } {
  const input = transaction.ins[index];
  const previous = Transaction.fromHex(previousHex);
  const output = input ? previous.outs[input.index] : undefined;
  if (
    !input ||
    !output ||
    !previous.getHash().equals(input.hash) ||
    BigInt(output.value) !== BigInt(declaredValue)
  )
    throw new ConnectError(
      ERROR_CODES.invalid,
      "Previous output does not match the transaction input"
    );
  return output;
}

export function validatePsbt(
  account: Account,
  request: Extract<SignRequest, { method: "signPsbt" }>
): Psbt {
  const psbt = Psbt.fromBase64(request.params.psbt, {
    network: utxoNetwork(account.chain),
  });
  const script = ownedScript(account);
  if (new Set(request.params.inputs).size !== request.params.inputs.length)
    throw new ConnectError(ERROR_CODES.invalid, "Duplicate PSBT input index");
  for (const index of request.params.inputs) {
    const input = psbt.data.inputs[index];
    const txInput = psbt.txInputs[index];
    if (
      !input ||
      !txInput ||
      (input.sighashType !== undefined &&
        input.sighashType !== Transaction.SIGHASH_ALL)
    )
      throw new ConnectError(
        ERROR_CODES.unsupported,
        "Only SIGHASH_ALL inputs can be signed"
      );
    let output = input.witnessUtxo;
    if (input.nonWitnessUtxo) {
      const previous = Transaction.fromBuffer(input.nonWitnessUtxo);
      if (!previous.getHash().equals(txInput.hash))
        throw new ConnectError(
          ERROR_CODES.invalid,
          "PSBT previous transaction does not match its input"
        );
      const verified = previous.outs[txInput.index];
      if (
        output &&
        verified &&
        (output.value !== verified.value ||
          !output.script.equals(verified.script))
      )
        throw new ConnectError(
          ERROR_CODES.invalid,
          "PSBT witness output does not match its previous transaction"
        );
      output = verified;
    }
    if (!output?.script.equals(script))
      throw new ConnectError(
        ERROR_CODES.unauthorized,
        "PSBT input does not belong to this registered account"
      );
  }
  return psbt;
}

export function validateUtxo(
  account: Account,
  request: Extract<SignRequest, { method: "signUtxoTransaction" }>
): Transaction {
  const transaction = Transaction.fromHex(request.params.transactionHex);
  if (
    request.params.inputs.length !== transaction.ins.length ||
    new Set(request.params.inputs.map((input) => input.index)).size !==
      transaction.ins.length
  )
    throw new ConnectError(
      ERROR_CODES.invalid,
      "Native UTXO requests must describe every input exactly once"
    );
  const script = ownedScript(account);
  for (const input of request.params.inputs)
    if (
      !previousOutput(
        transaction,
        input.index,
        input.previousTransactionHex,
        input.value
      ).script.equals(script)
    )
      throw new ConnectError(
        ERROR_CODES.unauthorized,
        "UTXO input does not belong to this registered account"
      );
  return transaction;
}

export function solanaTransaction(
  account: Account,
  encoded: string
): VersionedTransaction {
  const tx = VersionedTransaction.deserialize(unbase64(encoded));
  const signers = tx.message.staticAccountKeys.slice(
    0,
    tx.message.header.numRequiredSignatures
  );
  if (!signers.some((key) => key.toBase58() === account.address))
    throw new ConnectError(
      ERROR_CODES.unauthorized,
      "This account is not a signer of the Solana transaction"
    );
  return tx;
}

export function solanaKey(privateKey: Uint8Array): Keypair {
  return Keypair.fromSeed(privateKey);
}

export function validateTron(
  account: Account,
  transaction: Record<string, unknown>
): { rawDataHex: string; owner: string } {
  const schema = z
    .object({
      raw_data_hex: z.string().regex(/^(?:[a-fA-F0-9]{2})+$/),
      txID: z.string().regex(/^[a-fA-F0-9]{64}$/),
      raw_data: z
        .object({
          contract: z
            .array(
              z
                .object({
                  parameter: z
                    .object({
                      value: z
                        .object({ owner_address: z.string() })
                        .passthrough(),
                    })
                    .passthrough(),
                })
                .passthrough()
            )
            .min(1),
        })
        .passthrough(),
    })
    .passthrough();
  const parsed = schema.parse(transaction);
  if (!tronUtils.transaction.txCheck(parsed))
    throw new ConnectError(
      ERROR_CODES.invalid,
      "TRON raw bytes do not match the displayed transaction"
    );
  const owners = parsed.raw_data.contract.map(
    (contract) => contract.parameter.value.owner_address
  );
  if (
    owners.some(
      (owner) =>
        owner.toLowerCase() !==
        TronWeb.address.toHex(account.address).toLowerCase()
    )
  )
    throw new ConnectError(
      ERROR_CODES.unauthorized,
      "TRON transaction owner does not match the account"
    );
  return { rawDataHex: parsed.raw_data_hex, owner: account.address };
}

export function outputAddress(script: Buffer, chain: Chain): string {
  try {
    return (
      payments.p2pkh({ output: script, network: utxoNetwork(chain) }).address ??
      toHex(script)
    );
  } catch {
    try {
      return (
        payments.p2wpkh({ output: script, network: utxoNetwork(chain) })
          .address ?? toHex(script)
      );
    } catch {
      return toHex(script);
    }
  }
}
