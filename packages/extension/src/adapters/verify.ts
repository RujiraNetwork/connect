import { Buffer } from "buffer";

import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { canonicalJson, ConnectError, ERROR_CODES } from "@rujira/connect-core";
import { Psbt, Transaction, payments, script } from "bitcoinjs-lib";
import { SignDoc } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import {
  Transaction as EvmTx,
  Signature,
  SigningKey,
  getBytes,
  verifyMessage,
  recoverAddress,
} from "ethers";
import { decode, encodeForSigning } from "xrpl";
import { z } from "zod";

import { fromHex, toHex, unbase64 } from "./bytes";
import { addressFor } from "./keys";
import {
  evmTransaction,
  previousOutput,
  solanaTransaction,
  typedData,
  validatePsbt,
  validateTron,
} from "./transactions";

import type { Account, SignRequest } from "@rujira/connect-core";
import type { Transaction as XrpTransaction } from "xrpl";

function ensure(value: boolean): void {
  if (!value)
    throw new ConnectError(
      ERROR_CODES.invalid,
      "The returned signature does not match the approved request and account"
    );
}

export function verifyResult(
  account: Account,
  request: SignRequest,
  result: unknown
): void {
  switch (request.method) {
    case "eth_signTransaction": {
      const encoded = z.string().parse(result);
      const tx = EvmTx.from(encoded);
      const original = request.params;
      ensure(
        tx.from?.toLowerCase() === account.address.toLowerCase() &&
          tx.chainId === BigInt(original.chainId) &&
          tx.nonce === original.nonce &&
          tx.gasLimit === BigInt(original.gasLimit) &&
          tx.value === BigInt(original.value ?? "0") &&
          (tx.to ?? "").toLowerCase() === (original.to ?? "").toLowerCase() &&
          toHex(fromHex(tx.data)) === toHex(fromHex(original.data ?? ""))
      );
      ensure(
        tx.unsignedSerialized === evmTransaction(original).unsignedSerialized
      );
      return;
    }
    case "personal_sign":
      ensure(
        verifyMessage(
          fromHex(request.params.message),
          z.string().parse(result)
        ).toLowerCase() === account.address.toLowerCase()
      );
      return;
    case "eth_signTypedData_v4": {
      const data = typedData(request.params);
      ensure(
        recoverAddress(data.digest, z.string().parse(result)).toLowerCase() ===
          account.address.toLowerCase()
      );
      return;
    }
    case "signAmino":
    case "signDirect": {
      const parsed = z
        .object({
          signed: z.unknown(),
          signature: z.object({
            pub_key: z.object({ type: z.string(), value: z.string() }),
            signature: z.string(),
          }),
        })
        .parse(result);
      ensure(
        canonicalJson(parsed.signed) === canonicalJson(request.params) &&
          toHex(unbase64(parsed.signature.pub_key.value)) === account.publicKey
      );
      if (account.scheme === "eip712") {
        ensure(unbase64(parsed.signature.signature).length === 65);
        return;
      }
      const bytes =
        request.method === "signAmino"
          ? new TextEncoder().encode(canonicalJson(request.params))
          : SignDoc.encode(
              SignDoc.fromPartial({
                bodyBytes: fromHex(request.params.bodyBytes),
                authInfoBytes: fromHex(request.params.authInfoBytes),
                chainId: request.params.chainId,
                accountNumber: BigInt(request.params.accountNumber),
              })
            ).finish();
      ensure(
        secp256k1.verify(
          unbase64(parsed.signature.signature),
          sha256(bytes),
          fromHex(account.publicKey ?? "")
        )
      );
      return;
    }
    case "signPsbt": {
      const original = validatePsbt(account, request);
      const signed = Psbt.fromBase64(
        z.object({ psbt: z.string() }).parse(result).psbt
      );
      ensure(
        original.data.globalMap.unsignedTx
          .toBuffer()
          .equals(signed.data.globalMap.unsignedTx.toBuffer())
      );
      for (const index of request.params.inputs)
        ensure(
          signed.validateSignaturesOfInput(
            index,
            (publicKey, hash, signature) =>
              secp256k1.verify(signature, hash, publicKey),
            Buffer.from(fromHex(account.publicKey ?? ""))
          )
        );
      return;
    }
    case "signUtxoTransaction": {
      const original = Transaction.fromHex(request.params.transactionHex);
      const signed = Transaction.fromHex(
        z.object({ transactionHex: z.string() }).parse(result).transactionHex
      );
      ensure(
        signed.version === original.version &&
          signed.locktime === original.locktime &&
          signed.ins.length === original.ins.length &&
          signed.outs.length === original.outs.length
      );
      for (const [index, output] of signed.outs.entries()) {
        const originalOutput = original.outs[index];
        if (!originalOutput)
          throw new Error("Signed transaction added an output");
        ensure(
          output.value === originalOutput.value &&
            output.script.equals(originalOutput.script)
        );
      }
      for (const [index, input] of signed.ins.entries()) {
        const previous = original.ins[index];
        if (!previous) throw new Error("Signed transaction added an input");
        ensure(
          input.hash.equals(previous.hash) &&
            input.index === previous.index &&
            input.sequence === previous.sequence
        );
        if (!request.params.inputs.some((entry) => entry.index === index))
          ensure(
            input.script.equals(previous.script) &&
              canonicalJson(input.witness.map(toHex)) ===
                canonicalJson(previous.witness.map(toHex))
          );
      }
      for (const entry of request.params.inputs) {
        const input = signed.ins[entry.index];
        const originalInput = original.ins[entry.index];
        if (!input || !originalInput)
          throw new ConnectError(ERROR_CODES.invalid, "Missing signed input");
        ensure(
          input.hash.equals(originalInput.hash) &&
            input.index === originalInput.index &&
            input.sequence === originalInput.sequence
        );
        const previous = previousOutput(
          original,
          entry.index,
          entry.previousTransactionHex,
          entry.value
        );
        const segwit = account.path.startsWith("m/84'");
        const stack = segwit ? input.witness : script.decompile(input.script);
        const signature = stack?.[0];
        const publicKey = stack?.[1];
        if (!Buffer.isBuffer(signature) || !Buffer.isBuffer(publicKey))
          throw new ConnectError(ERROR_CODES.invalid, "Invalid signed input");
        const sighash = account.chain === "BCH" ? 0x41 : 1;
        ensure(
          signature[signature.length - 1] === sighash &&
            toHex(publicKey) === account.publicKey
        );
        const code = segwit
          ? payments.p2pkh({ pubkey: publicKey }).output
          : previous.script;
        if (!code)
          throw new ConnectError(ERROR_CODES.invalid, "Invalid signing script");
        const hash =
          segwit || account.chain === "BCH"
            ? original.hashForWitnessV0(
                entry.index,
                code,
                previous.value,
                sighash
              )
            : original.hashForSignature(entry.index, code, sighash);
        ensure(
          secp256k1.verify(
            secp256k1.Signature.fromBytes(
              signature.subarray(0, -1),
              "der"
            ).toBytes("compact"),
            hash,
            publicKey
          )
        );
      }
      return;
    }
    case "signSolanaTransaction": {
      const original = solanaTransaction(account, request.params.transaction);
      const signed = solanaTransaction(
        account,
        z.object({ transaction: z.string() }).parse(result).transaction
      );
      ensure(
        toHex(original.message.serialize()) ===
          toHex(signed.message.serialize())
      );
      const index = signed.message.staticAccountKeys.findIndex(
        (key) => key.toBase58() === account.address
      );
      const signature = signed.signatures[index];
      ensure(
        signature !== undefined &&
          ed25519.verify(
            signature,
            signed.message.serialize(),
            fromHex(account.publicKey ?? "")
          )
      );
      signed.signatures.forEach((entry, signerIndex) => {
        if (signerIndex !== index)
          ensure(
            toHex(entry) ===
              toHex(original.signatures[signerIndex] ?? new Uint8Array())
          );
      });
      return;
    }
    case "signSolanaMessage":
      ensure(
        ed25519.verify(
          unbase64(z.object({ signature: z.string() }).parse(result).signature),
          fromHex(request.params.message),
          fromHex(account.publicKey ?? "")
        )
      );
      return;
    case "signXrpTransaction": {
      const tx = decode(
        z.object({ tx_blob: z.string() }).parse(result).tx_blob
      );
      const { SigningPubKey, TxnSignature, ...unsigned } = tx;
      ensure(canonicalJson(unsigned) === canonicalJson(request.params));
      const pubkey = z.string().parse(SigningPubKey);
      const signature = z.string().parse(TxnSignature);
      ensure(
        addressFor("XRP", fromHex(pubkey), account.path) === account.address
      );
      const hash = sha512(
        fromHex(encodeForSigning(tx as XrpTransaction))
      ).subarray(0, 32);
      ensure(
        secp256k1.verify(
          secp256k1.Signature.fromBytes(fromHex(signature), "der").toBytes(
            "compact"
          ),
          hash,
          fromHex(pubkey)
        )
      );
      return;
    }
    case "signTronTransaction": {
      const returned = z.record(z.unknown()).parse(result);
      const signature = z
        .array(z.string())
        .length(1)
        .parse(returned.signature)[0];
      const unsigned = Object.fromEntries(
        Object.entries(returned).filter(([key]) => key !== "signature")
      );
      ensure(canonicalJson(unsigned) === canonicalJson(request.params));
      const tx = validateTron(account, unsigned);
      const bytes = fromHex(signature ?? "");
      ensure(bytes.length === 65);
      const recovery = bytes[64] ?? 27;
      const recovered = getBytes(
        SigningKey.computePublicKey(
          SigningKey.recoverPublicKey(
            sha256(fromHex(tx.rawDataHex)),
            Signature.from({
              r: `0x${toHex(bytes.subarray(0, 32))}`,
              s: `0x${toHex(bytes.subarray(32, 64))}`,
              v: recovery >= 27 ? recovery : recovery + 27,
            })
          ),
          true
        )
      );
      ensure(addressFor("TRON", recovered, account.path) === account.address);
      return;
    }
    case "signMoneroTransfer": {
      const signed = z
        .object({
          transactionHex: z.string().regex(/^(?:[a-f0-9]{2})+$/),
          transactionHash: z.string().length(64),
          fee: z.string(),
          amount: z.string(),
        })
        .parse(result);
      ensure(
        BigInt(signed.fee) <= BigInt(request.params.maxFee) &&
          BigInt(signed.amount) ===
            request.params.destinations.reduce(
              (sum, entry) => sum + BigInt(entry.amount),
              0n
            )
      );
      return;
    }
  }
}
