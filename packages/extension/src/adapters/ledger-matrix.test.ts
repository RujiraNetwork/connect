import { Buffer } from "buffer";

import {
  DeviceActionStatus,
  DeviceManagementKitBuilder,
  DeviceModel,
  DeviceModelId,
} from "@ledgerhq/device-management-kit";
import { DefaultSignerBtc } from "@ledgerhq/device-signer-kit-bitcoin/internal/DefaultSignerBtc.js";
import { DefaultSignerEth } from "@ledgerhq/device-signer-kit-ethereum/internal/DefaultSignerEth.js";
import { DefaultSignerSolana } from "@ledgerhq/device-signer-kit-solana/internal/DefaultSignerSolana.js";
import Btc from "@ledgerhq/hw-app-btc";
import Cosmos from "@ledgerhq/hw-app-cosmos";
import Trx from "@ledgerhq/hw-app-trx";
import Xrp from "@ledgerhq/hw-app-xrp";
import { secp256k1 } from "@noble/curves/secp256k1";
import { supportedMethods } from "@rujira/connect-core";
import { HDKey } from "@scure/bip32";
import { Transaction as SolanaTransaction } from "@solana/web3.js";
import THORChainApp from "@xchainjs/ledger-thorchain";
import { Psbt, Transaction } from "bitcoinjs-lib";
import { Signature, Transaction as EthereumTransaction } from "ethers";
import { of } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "xrpl";
import { z } from "zod";

import { fromHex, hex0x, toHex, unbase64 } from "./bytes";
import { FIXTURE_SEED, signingFixtures } from "./fixtures/signing";
import { LedgerAdapter } from "./ledger";
import { verifyResult } from "./verify";

const fixtures = signingFixtures().filter(
  ({ account, request }) =>
    account.chain !== "XMR" &&
    supportedMethods(account.chain, "ledger").includes(request.method)
);
const root = HDKey.fromMasterSeed(FIXTURE_SEED);
function completed<T>(output: T) {
  return {
    observable: of({ status: DeviceActionStatus.Completed as const, output }),
    cancel: vi.fn(),
  };
}
const signedUtxo = z.object({ transactionHex: z.string() });
const signedPsbt = z.object({ psbt: z.string() });
const signedSignature = z.object({ signature: z.string() });

describe("Ledger connection and signing capability matrix", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("covers every advertised method alongside the firmware-backed Monero tests", () => {
    for (const { account } of fixtures)
      expect(
        [
          ...new Set(
            fixtures
              .filter((entry) => entry.account.chain === account.chain)
              .map((entry) => entry.request.method)
          ),
        ].sort()
      ).toEqual([...supportedMethods(account.chain, "ledger")].sort());
  });
  it.each(fixtures)(
    "registers, binds and verifies $account.chain / $request.method",
    async ({ account: software, request, signed }) => {
      const account = {
        ...software,
        source: "ledger" as const,
        methods: [...supportedMethods(software.chain, "ledger")],
      };
      const key = fromHex(account.publicKey ?? "");
      const dmk = new DeviceManagementKitBuilder().build();
      vi.spyOn(dmk, "listenToAvailableDevices").mockReturnValue(
        of([
          {
            id: "public-device",
            name: "Ledger Nano S",
            deviceModel: new DeviceModel({
              id: "public-device",
              model: DeviceModelId.NANO_S,
              name: "Ledger Nano S",
            }),
            transport: "WEB-HID",
          },
        ])
      );
      vi.spyOn(dmk, "connect").mockResolvedValue("public-session");
      vi.spyOn(dmk, "executeDeviceAction").mockReturnValue(
        completed(undefined)
      );
      vi.spyOn(DefaultSignerEth.prototype, "getAddress").mockReturnValue(
        completed({
          publicKey: toHex(key),
          address: `0x${account.address.replace(/^0x/, "")}`,
        })
      );
      vi.spyOn(DefaultSignerSolana.prototype, "getAddress").mockReturnValue(
        completed(account.address)
      );
      vi.spyOn(
        DefaultSignerBtc.prototype,
        "getExtendedPublicKey"
      ).mockImplementation((path) =>
        completed({
          extendedPublicKey: root.derive(`m/${path}`).publicExtendedKey,
        })
      );
      vi.spyOn(DefaultSignerBtc.prototype, "getWalletAddress").mockReturnValue(
        completed({ address: account.address })
      );
      vi.spyOn(Btc.prototype, "getWalletPublicKey").mockResolvedValue({
        publicKey: toHex(key),
        bitcoinAddress: account.address,
        chainCode: "00".repeat(32),
      });
      vi.spyOn(Cosmos.prototype, "getAddress").mockResolvedValue({
        publicKey: toHex(key),
        address: account.address,
      });
      vi.spyOn(
        THORChainApp.prototype,
        "showAddressAndPubKey"
      ).mockResolvedValue({
        compressedPk: Buffer.from(key),
        bech32Address: account.address,
        returnCode: 0x9000,
        errorMessage: "No errors",
      });
      vi.spyOn(Xrp.prototype, "getAddress").mockResolvedValue({
        publicKey: toHex(key),
        address: account.address,
        chainCode: "00".repeat(32),
      });
      vi.spyOn(Trx.prototype, "getAddress").mockResolvedValue({
        publicKey: toHex(key),
        address: account.address,
      });
      switch (request.method) {
        case "eth_signTransaction": {
          const signature = EthereumTransaction.from(
            z.string().parse(signed)
          ).signature;
          if (!signature) throw new Error("No fixture signature");
          vi.spyOn(
            DefaultSignerEth.prototype,
            "signTransaction"
          ).mockReturnValue(
            completed({
              r: hex0x(fromHex(signature.r)),
              s: hex0x(fromHex(signature.s)),
              v: signature.v,
            })
          );
          break;
        }
        case "personal_sign":
        case "eth_signTypedData_v4": {
          const signature = Signature.from(z.string().parse(signed));
          const method =
            request.method === "personal_sign"
              ? "signMessage"
              : "signTypedData";
          vi.spyOn(DefaultSignerEth.prototype, method).mockReturnValue(
            completed({
              r: hex0x(fromHex(signature.r)),
              s: hex0x(fromHex(signature.s)),
              v: signature.v,
            })
          );
          break;
        }
        case "signAmino": {
          const signature = z
            .object({ signature: signedSignature })
            .parse(signed).signature.signature;
          const der = Buffer.from(
            secp256k1.Signature.fromBytes(
              unbase64(signature),
              "compact"
            ).toBytes("der")
          );
          vi.spyOn(Cosmos.prototype, "sign").mockResolvedValue({
            signature: der,
            return_code: 0x9000,
          });
          vi.spyOn(THORChainApp.prototype, "sign").mockResolvedValue({
            signature: der,
            returnCode: 0x9000,
            errorMessage: "No errors",
          });
          break;
        }
        case "signUtxoTransaction":
        case "signPsbt": {
          if (account.chain === "BTC") {
            const partial =
              request.method === "signPsbt"
                ? Psbt.fromBase64(signedPsbt.parse(signed).psbt).data.inputs[0]
                    ?.partialSig?.[0]?.signature
                : Transaction.fromHex(signedUtxo.parse(signed).transactionHex)
                    .ins[0]?.witness[0];
            if (!partial) throw new Error("Missing Bitcoin signature");
            vi.spyOn(
              DefaultSignerBtc.prototype,
              "getMasterFingerprint"
            ).mockReturnValue(
              completed({ masterFingerprint: new Uint8Array(4) })
            );
            vi.spyOn(DefaultSignerBtc.prototype, "signPsbt").mockReturnValue(
              completed([
                {
                  inputIndex: 0,
                  pubkey: key,
                  signature: new Uint8Array(partial),
                },
              ])
            );
          } else
            vi.spyOn(
              Btc.prototype,
              "createPaymentTransaction"
            ).mockResolvedValue(signedUtxo.parse(signed).transactionHex);
          break;
        }
        case "signSolanaTransaction": {
          const tx = SolanaTransaction.from(
            unbase64(
              z.object({ transaction: z.string() }).parse(signed).transaction
            )
          );
          if (!tx.signature) throw new Error("No Solana signature");
          vi.spyOn(
            DefaultSignerSolana.prototype,
            "signTransaction"
          ).mockReturnValue(completed(new Uint8Array(tx.signature)));
          break;
        }
        case "signSolanaMessage":
          vi.spyOn(
            DefaultSignerSolana.prototype,
            "signMessage"
          ).mockReturnValue(
            completed({
              signature: toHex(
                unbase64(signedSignature.parse(signed).signature)
              ),
            })
          );
          break;
        case "signXrpTransaction": {
          const tx = decode(
            z.object({ tx_blob: z.string() }).parse(signed).tx_blob
          );
          vi.spyOn(Xrp.prototype, "signTransaction").mockResolvedValue(
            z.string().parse(tx.TxnSignature)
          );
          break;
        }
        case "signTronTransaction":
          vi.spyOn(Trx.prototype, "signTransaction").mockResolvedValue(
            z.object({ signature: z.array(z.string()) }).parse(signed)
              .signature[0] ?? ""
          );
          break;
        case "signDirect":
        case "signMoneroTransaction":
          throw new Error("Method belongs to another test suite");
      }
      const adapter = new LedgerAdapter(dmk);
      const registered = await adapter.register(account);
      expect(registered.account).toEqual(account);
      verifyResult(account, request, await adapter.sign(account, request));
      await expect(
        adapter.sign(account, { ...request, accountId: crypto.randomUUID() })
      ).rejects.toThrow();
      await expect(
        adapter.sign({ ...account, publicKey: "wrong-device" }, request)
      ).rejects.toThrow("used to register");
    }
  );
});
