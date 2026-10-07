import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { protobufManager } from "@trezor/protobuf";
import * as bitcoin from "@trezor/protobuf/lib/definitions/messages-bitcoin_pb.js";
import * as common from "@trezor/protobuf/lib/definitions/messages-common_pb.js";
import * as ethereum from "@trezor/protobuf/lib/definitions/messages-ethereum_pb.js";
import * as management from "@trezor/protobuf/lib/definitions/messages-management_pb.js";
import * as messages from "@trezor/protobuf/lib/definitions/messages_pb.js";
import { v1 } from "@trezor/protocol";

import { addressFor } from "../src/adapters/keys";

import type { Worker } from "@playwright/test";

protobufManager.load({
  AddressSchema: bitcoin.AddressSchema,
  GetAddressSchema: bitcoin.GetAddressSchema,
  FailureSchema: common.FailureSchema,
  Failure_FailureTypeSchema: common.Failure_FailureTypeSchema,
  PassphraseRequestSchema: common.PassphraseRequestSchema,
  PassphraseAckSchema: common.PassphraseAckSchema,
  EthereumAddressSchema: ethereum.EthereumAddressSchema,
  EthereumGetAddressSchema: ethereum.EthereumGetAddressSchema,
  EthereumGetPublicKeySchema: ethereum.EthereumGetPublicKeySchema,
  EthereumPublicKeySchema: ethereum.EthereumPublicKeySchema,
  CancelSchema: management.CancelSchema,
  GetFeaturesSchema: management.GetFeaturesSchema,
  InitializeSchema: management.InitializeSchema,
  FeaturesSchema: management.FeaturesSchema,
  Features_CapabilitySchema: management.Features_CapabilitySchema,
  MessageTypeSchema: messages.MessageTypeSchema,
});

function frames(name: string, data: Record<string, unknown>): number[][] {
  const { message, messageType } = protobufManager.encode(name, data);
  const encoded = v1.encode(message, { messageType });
  const chunks: number[][] = [];
  for (let offset = 0; offset < encoded.length;) {
    const chunk = new Uint8Array(64);
    const start = offset === 0 ? 0 : 1;
    if (start) chunk[0] = 0x3f;
    const part = encoded.subarray(offset, offset + 64 - start);
    chunk.set(part, start);
    chunks.push([...chunk]);
    offset += part.length;
  }
  return chunks;
}

/** Public firmware responses through the actual bundled SDK and USB transport. */
export async function installTrezorFixture(
  worker: Worker,
  bitcoinOnly = false,
  passphrase = false
): Promise<string> {
  const root = HDKey.fromMasterSeed(
    mnemonicToSeedSync(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    )
  );
  const path = "m/44'/60'/0'/0/0";
  const key = root.derive(path);
  if (!key.publicKey) throw new Error("Missing public Trezor fixture key");
  const address = addressFor("THOR", key.publicKey, path, "eip712");
  const node = (key: HDKey): Record<string, unknown> => ({
    depth: key.depth,
    fingerprint: key.parentFingerprint,
    child_num: key.index,
    chain_code: key.chainCode,
    public_key: key.publicKey,
  });
  const featureFrames = frames("Features", {
    vendor: "trezor.io",
    major_version: 2,
    minor_version: 12,
    patch_version: 5,
    device_id: "safe3-public-fixture",
    initialized: true,
    unlocked: true,
    passphrase_protection: passphrase,
    model: "R",
    internal_model: "T3B1",
    capabilities: bitcoinOnly
      ? ["Capability_Bitcoin"]
      : ["Capability_Bitcoin", "Capability_Ethereum"],
  });
  const responses: Record<number, number[][][]> = {};
  const reply = (name: string, payloads: number[][][]): void => {
    responses[protobufManager.findSchema(name).messageType] = payloads;
  };
  reply("Cancel", [
    frames("Failure", {
      code: "Failure_ActionCancelled",
      message: "Cancelled",
    }),
  ]);
  reply("GetFeatures", [featureFrames]);
  reply("Initialize", [featureFrames]);
  reply("GetAddress", [
    ...(passphrase ? [frames("PassphraseRequest", { on_device: false })] : []),
    frames("Address", { address: "mkpZhYtJu2r87Js3pDiWJDmPte2NRZ8bJV" }),
  ]);
  reply("PassphraseAck", [
    frames("Address", { address: "mkpZhYtJu2r87Js3pDiWJDmPte2NRZ8bJV" }),
  ]);
  reply("EthereumGetAddress", [
    frames("EthereumAddress", {
      address: addressFor("ETH", key.publicKey, path),
    }),
  ]);
  reply(
    "EthereumGetPublicKey",
    [key, key.deriveChild(0)].map((entry) =>
      frames("EthereumPublicKey", {
        node: node(entry),
        xpub: entry.publicExtendedKey,
      })
    )
  );
  await worker.evaluate(
    ({ responses, addressType }) => {
      let pending: number[] = [];
      let length = 0;
      let type = 0;
      const queue: number[][] = [];
      const counts: Record<number, number> = {};
      const claimed = { interfaceNumber: 0, claimed: false };
      const device = {
        vendorId: 0x1209,
        productId: 0x53c1,
        productName: "Trezor Safe 3",
        deviceVersionMajor: 2,
        deviceVersionMinor: 0,
        deviceVersionSubminor: 0,
        serialNumber: "safe3-public-fixture",
        opened: false,
        configuration: { configurationValue: 1, interfaces: [claimed] },
        open(): Promise<void> {
          this.opened = true;
          return Promise.resolve();
        },
        close(): Promise<void> {
          this.opened = false;
          return Promise.resolve();
        },
        selectConfiguration(): Promise<void> {
          return Promise.resolve();
        },
        claimInterface(): Promise<void> {
          claimed.claimed = true;
          return Promise.resolve();
        },
        releaseInterface(): Promise<void> {
          claimed.claimed = false;
          return Promise.resolve();
        },
        reset(): Promise<void> {
          return Promise.resolve();
        },
        transferOut(
          _endpoint: number,
          chunk: Uint8Array
        ): Promise<{ status: "ok" }> {
          if (chunk[1] === 0x23 && chunk[2] === 0x23) {
            pending = [];
            type = (chunk[3] ?? 0) * 256 + (chunk[4] ?? 0);
            length = new DataView(chunk.buffer).getUint32(5);
            pending.push(...chunk.subarray(9));
          } else pending.push(...chunk.subarray(1));
          if (pending.length >= length) {
            const options = responses[type];
            if (!options)
              throw new Error(`Unexpected Trezor command: ${String(type)}`);
            const index = counts[type] ?? 0;
            const frames =
              options[
                type === addressType
                  ? Math.min(index, options.length - 1)
                  : index % options.length
              ];
            if (!frames) throw new Error("Missing Trezor response");
            counts[type] = index + 1;
            queue.push(...frames);
          }
          return Promise.resolve({ status: "ok" });
        },
        transferIn(): Promise<{ status: "ok"; data: DataView }> {
          const chunk = queue.shift();
          if (!chunk) throw new Error("Trezor response queue is empty");
          return Promise.resolve({
            status: "ok",
            data: new DataView(new Uint8Array(chunk).buffer),
          });
        },
      };
      Object.defineProperty(navigator, "usb", {
        configurable: true,
        value: {
          getDevices: () => Promise.resolve([device]),
          onconnect: null,
          ondisconnect: null,
        },
      });
    },
    {
      responses,
      addressType: protobufManager.findSchema("GetAddress").messageType,
    }
  );
  return address;
}
