import { Buffer } from "buffer";

import { supportedMethods, accountPath } from "@rujira/connect-core";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  PublicKey,
  Transaction as SolanaTransaction,
  SystemProgram,
} from "@solana/web3.js";
import { encryptToKeyStore } from "@xchainjs/xchain-crypto";
import {
  Client as MoneroClient,
  defaultXMRParams,
} from "@xchainjs/xchain-monero";
import { Transaction, Psbt, payments } from "bitcoinjs-lib";
import { SigningKey, verifyMessage, Wallet } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";

import { base64, fromHex } from "./bytes";
import { privateKeyFor } from "./keys";
import { decryptKeystore, KeystoreSessions } from "./keystore";
import { moneroKeys } from "./monero-keys";
import { registerSoftware, signSoftware } from "./software";
import { validatePsbt } from "./transactions";
import { verifyResult } from "./verify";

import type { Account, Chain, SignRequest } from "@rujira/connect-core";
import type { Keystore } from "@xchainjs/xchain-crypto";

const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "public-test-fixture-password";
const seed = mnemonicToSeedSync(PHRASE);
function registered(chain: Chain): Account {
  return registerSoftware(seed, {
    id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    sourceId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    source: "keystore",
    chain,
    path: accountPath(chain, 0, "keystore"),
    label: "Public test fixture",
    scheme: "native",
    verifiedAt: 0,
    methods: [...supportedMethods(chain, "keystore")],
  });
}
function sign(account: Account, request: SignRequest): unknown {
  const result = signSoftware(seed, account, request);
  verifyResult(account, request, result);
  return result;
}

describe("encrypted keystore and deterministic signatures", () => {
  let keystore: Keystore;
  beforeAll(async () => {
    keystore = await encryptToKeyStore(PHRASE, PASSWORD);
  });
  it("decrypts the official XChain keystore format and rejects a bad password", async () => {
    expect(await decryptKeystore(keystore, PASSWORD)).toEqual(seed);
    await expect(decryptKeystore(keystore, "wrong")).rejects.toThrow();
    const changed = structuredClone(keystore);
    changed.crypto.ciphertext = `00${changed.crypto.ciphertext.slice(2)}`;
    await expect(decryptKeystore(changed, PASSWORD)).rejects.toThrow();
  });
  it("zeros and expires unlocked seeds after five minutes", async () => {
    let now = 0;
    const sessions = new KeystoreSessions(() => now);
    await sessions.unlock("fixture", keystore, PASSWORD);
    const live = sessions.seed("fixture");
    expect(live).toEqual(seed);
    now = 300_001;
    expect(() => sessions.seed("fixture")).toThrow();
    expect(live.every((value) => value === 0)).toBe(true);
  });
  it("does not reopen a session when locking interrupts password derivation", async () => {
    const sessions = new KeystoreSessions();
    const unlocking = sessions.unlock("fixture", keystore, PASSWORD);
    sessions.lock();
    await expect(unlocking).rejects.toThrow("cancelled");
    expect(() => sessions.seed("fixture")).toThrow("Unlock");
  });
  it("matches the standard BIP44 Ethereum address and EIP-191 signature", () => {
    const account = registered("ETH");
    expect(account.address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
    const message = "68656c6c6f";
    const signed = sign(account, {
      accountId: account.id,
      chain: "ETH",
      method: "personal_sign",
      params: { message },
    });
    expect(typeof signed).toBe("string");
    if (typeof signed !== "string") throw new Error("Invalid signature");
    expect(verifyMessage(fromHex(message), signed)).toBe(account.address);
  });
  it("signs a prepared EVM transaction and detects altered outputs", async () => {
    const account = registered("ETH");
    const params = {
      chainId: "1",
      nonce: 0,
      gasLimit: "21000",
      gasPrice: "1",
      to: account.address,
      value: "2",
    };
    const request: SignRequest = {
      accountId: account.id,
      chain: "ETH",
      method: "eth_signTransaction",
      params,
    };
    const result = sign(account, request);
    const wallet = new Wallet(
      new SigningKey(privateKeyFor(seed, "ETH", account.path))
    );
    expect(result).toBe(await wallet.signTransaction({ ...params, type: 0 }));
    expect(() => {
      verifyResult(
        account,
        { ...request, params: { ...params, value: "3" } },
        result
      );
    }).toThrow("approved");
  });
  it("signs and validates EIP-712 payloads", () => {
    const account = registered("BASE");
    sign(account, {
      accountId: account.id,
      chain: "BASE",
      method: "eth_signTypedData_v4",
      params: {
        domain: { name: "Rujira", chainId: 8453 },
        primaryType: "Message",
        types: { Message: [{ name: "contents", type: "string" }] },
        message: { contents: "Public signing fixture" },
      },
    });
  });
  it.each(["THOR", "GAIA"] as const)(
    "signs %s Amino and direct documents",
    (chain) => {
      const account = registered(chain);
      sign(account, {
        accountId: account.id,
        chain,
        method: "signAmino",
        params: {
          chain_id: chain === "THOR" ? "thorchain-1" : "cosmoshub-4",
          account_number: "0",
          sequence: "0",
          fee: { amount: [], gas: "10000" },
          msgs: [{ type: "test/Msg", value: { sender: account.address } }],
          memo: "fixture",
        },
      });
      sign(account, {
        accountId: account.id,
        chain,
        method: "signDirect",
        params: {
          bodyBytes: "0a00",
          authInfoBytes: "1200",
          chainId: chain === "THOR" ? "thorchain-1" : "cosmoshub-4",
          accountNumber: "0",
        },
      });
    }
  );
  it.each(["BTC", "BCH", "LTC", "DOGE"] as const)(
    "preserves and verifies %s transaction inputs and outputs",
    (chain) => {
      const account = registered(chain);
      const pubkey = Buffer.from(fromHex(account.publicKey ?? ""));
      const previous = new Transaction();
      previous.addInput(Buffer.alloc(32), 0xffffffff);
      const output = account.path.startsWith("m/84'")
        ? payments.p2wpkh({ pubkey }).output
        : payments.p2pkh({ pubkey }).output;
      if (!output) throw new Error("Missing output script");
      previous.addOutput(output, 100_000);
      const tx = new Transaction();
      tx.addInput(previous.getHash(), 0);
      tx.addOutput(output, 90_000);
      sign(account, {
        accountId: account.id,
        chain,
        method: "signUtxoTransaction",
        params: {
          transactionHex: tx.toHex(),
          inputs: [
            {
              index: 0,
              previousTransactionHex: previous.toHex(),
              value: "100000",
            },
          ],
        },
      });
      if (chain === "BTC") {
        const psbt = new Psbt();
        psbt.addInput({
          hash: previous.getHash(),
          index: 0,
          nonWitnessUtxo: previous.toBuffer(),
        });
        psbt.addOutput({ script: output, value: 90_000 });
        const request: Extract<SignRequest, { method: "signPsbt" }> = {
          accountId: account.id,
          chain,
          method: "signPsbt",
          params: { psbt: psbt.toBase64(), inputs: [0] },
        };
        sign(account, request);
        psbt.updateInput(0, { sighashType: Transaction.SIGHASH_NONE });
        expect(() =>
          validatePsbt(account, {
            ...request,
            params: { ...request.params, psbt: psbt.toBase64() },
          })
        ).toThrow("SIGHASH_ALL");
      }
    }
  );
  it("preserves the Solana message and verifies its signatures", () => {
    const account = registered("SOL");
    const tx = new SolanaTransaction({
      feePayer: new PublicKey(account.address),
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
    }).add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(account.address),
        toPubkey: new PublicKey(account.address),
        lamports: 1,
      })
    );
    sign(account, {
      accountId: account.id,
      chain: "SOL",
      method: "signSolanaTransaction",
      params: {
        transaction: base64(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false })
        ),
      },
    });
    sign(account, {
      accountId: account.id,
      chain: "SOL",
      method: "signSolanaMessage",
      params: { message: "68656c6c6f" },
    });
  });
  it("signs an XRP payment with the expected account", () => {
    const account = registered("XRP");
    sign(account, {
      accountId: account.id,
      chain: "XRP",
      method: "signXrpTransaction",
      params: {
        TransactionType: "Payment",
        Account: account.address,
        Destination: account.address,
        Amount: "1",
        Fee: "12",
        Sequence: 1,
      },
    });
  });
  it("matches XChain Monero derivation across account indices", () => {
    const client = new MoneroClient({ phrase: PHRASE, ...defaultXMRParams });
    for (const index of [0, 1, 7])
      expect(
        moneroKeys(seed, accountPath("XMR", index, "keystore")).address
      ).toBe(client.getAddress(index));
  });
});
