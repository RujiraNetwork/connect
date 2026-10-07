import { Buffer } from "buffer";

import { sha256 } from "@noble/hashes/sha2";
import { CHAINS, accountPath, supportedMethods } from "@rujira/connect-core";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  PublicKey,
  SystemProgram,
  Transaction as SolanaTransaction,
} from "@solana/web3.js";
import { Psbt, Transaction, payments } from "bitcoinjs-lib";
import { TronWeb, utils as tronUtils } from "tronweb";

import { nativeMoneroFixture } from "./monero-native";
import { base64, fromHex, toHex } from "../bytes";
import { moneroKeys } from "../monero-keys";
import { registerSoftware, signSoftware } from "../software";

import type { Account, Chain, SignRequest } from "@rujira/connect-core";

export const FIXTURE_SEED = mnemonicToSeedSync(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
);
export function signingFixtures(): {
  account: Account;
  request: SignRequest;
  signed: unknown;
}[] {
  const cases: { account: Account; request: SignRequest; signed: unknown }[] =
    [];
  for (const chain of Object.keys(CHAINS) as Chain[]) {
    const account = registerSoftware(FIXTURE_SEED, {
      id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      sourceId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      source: "keystore",
      chain,
      path: accountPath(chain, 0, "keystore"),
      scheme: "native",
      methods: [...supportedMethods(chain, "keystore")],
      label: "Public test wallet",
      verifiedAt: 0,
    });
    const add = (request: SignRequest): void => {
      cases.push({
        account,
        request,
        signed: signSoftware(FIXTURE_SEED, account, request),
      });
    };
    const common = { accountId: account.id, chain };
    for (const method of account.methods)
      switch (method) {
        case "eth_signTransaction":
          add({
            ...common,
            method,
            params: {
              chainId: String(CHAINS[chain].evmChainId),
              nonce: 0,
              gasLimit: "21000",
              gasPrice: "1",
              to: account.address,
              value: "2",
            },
          });
          break;
        case "personal_sign":
          add({ ...common, method, params: { message: "68656c6c6f" } });
          break;
        case "eth_signTypedData_v4":
          add({
            ...common,
            method,
            params: {
              domain: {
                name: "Public fixture",
                chainId: Number(String(CHAINS[chain].evmChainId)),
              },
              primaryType: "Message",
              types: { Message: [{ name: "contents", type: "string" }] },
              message: { contents: "Offline signing" },
            },
          });
          break;
        case "signAmino":
          add({
            ...common,
            method,
            params: {
              chain_id: chain === "THOR" ? "thorchain-1" : "cosmoshub-4",
              account_number: "0",
              sequence: "0",
              fee: { amount: [], gas: "10000" },
              msgs: [{ type: "test/Msg", value: { sender: account.address } }],
              memo: "fixture",
            },
          });
          break;
        case "signDirect":
          add({
            ...common,
            method,
            params: {
              bodyBytes: "0a00",
              authInfoBytes: "1200",
              chainId: chain === "THOR" ? "thorchain-1" : "cosmoshub-4",
              accountNumber: "0",
            },
          });
          break;
        case "signUtxoTransaction":
        case "signPsbt": {
          const pubkey = Buffer.from(fromHex(account.publicKey ?? ""));
          const script = account.path.startsWith("m/84'")
            ? payments.p2wpkh({ pubkey }).output
            : payments.p2pkh({ pubkey }).output;
          if (!script) throw new Error("Missing fixture output");
          const previous = new Transaction();
          previous.addInput(Buffer.alloc(32), 0xffffffff);
          previous.addOutput(script, chain === "DOGE" ? 1000000000 : 100000);
          const transaction = new Transaction();
          transaction.addInput(previous.getHash(), 0);
          transaction.addOutput(script, chain === "DOGE" ? 999000000 : 90000);
          if (method === "signUtxoTransaction")
            add({
              ...common,
              method,
              params: {
                transactionHex: transaction.toHex(),
                inputs: [
                  {
                    index: 0,
                    previousTransactionHex: previous.toHex(),
                    value: chain === "DOGE" ? "1000000000" : "100000",
                  },
                ],
              },
            });
          else {
            const psbt = new Psbt();
            psbt.addInput({
              hash: previous.getHash(),
              index: 0,
              nonWitnessUtxo: previous.toBuffer(),
            });
            psbt.addOutput({ script, value: 90000 });
            add({
              ...common,
              method,
              params: { psbt: psbt.toBase64(), inputs: [0] },
            });
          }
          break;
        }
        case "signSolanaTransaction": {
          const key = new PublicKey(account.address);
          const transaction = new SolanaTransaction({
            feePayer: key,
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 1,
          }).add(
            SystemProgram.transfer({
              fromPubkey: key,
              toPubkey: key,
              lamports: 1,
            })
          );
          add({
            ...common,
            method,
            params: {
              transaction: base64(
                transaction.serialize({
                  requireAllSignatures: false,
                  verifySignatures: false,
                })
              ),
            },
          });
          break;
        }
        case "signSolanaMessage":
          add({ ...common, method, params: { message: "68656c6c6f" } });
          break;
        case "signXrpTransaction":
          add({
            ...common,
            method,
            params: {
              TransactionType: "Payment",
              Account: account.address,
              Destination: account.address,
              Amount: "1",
              Fee: "12",
              Sequence: 1,
            },
          });
          break;
        case "signTronTransaction": {
          const address = TronWeb.address.toHex(account.address);
          const raw = {
            ref_block_bytes: "0001",
            ref_block_hash: "0000000000000001",
            expiration: 1700000060000,
            timestamp: 1700000000000,
            contract: [
              {
                type: "TransferContract",
                parameter: {
                  type_url: "type.googleapis.com/protocol.TransferContract",
                  value: {
                    owner_address: address,
                    to_address: address,
                    amount: 1,
                  },
                },
              },
            ],
          };
          const native = tronUtils.transaction.txJsonToPb({
            raw_data: raw,
            raw_data_hex: "",
            txID: "",
          }) as { getRawData: () => { serializeBinary: () => Uint8Array } };
          const bytes = native.getRawData().serializeBinary();
          add({
            ...common,
            method,
            params: {
              raw_data: raw,
              raw_data_hex: toHex(bytes),
              txID: toHex(sha256(bytes)),
            },
          });
          break;
        }
        case "signMoneroTransaction": {
          const keys = moneroKeys(FIXTURE_SEED, account.path);
          const { prepared } = nativeMoneroFixture(
            fromHex(keys.spendKey),
            fromHex(keys.viewKey)
          );
          add({ ...common, method, params: prepared });
          break;
        }
      }
  }
  return cases;
}
