import { createCipheriv } from "node:crypto";

import { ed25519 } from "@noble/curves/ed25519";
import { keccak256 } from "ethers";

import { fromHex, toHex } from "../bytes";
import { moneroAddress, moneroPublicKeys } from "../monero-keys";

import type { Account, PreparedMoneroTransaction } from "@rujira/connect-core";

/** Public test keys and synthetic device parts: tests encoding, not chain validity. */
export function moneroFixture(): {
  account: Account;
  prepared: PreparedMoneroTransaction;
  device: Record<string, unknown>;
  transactionHex: string;
  transactionHash: string;
} {
  const point = (value: number): string =>
    toHex(ed25519.Point.BASE.multiply(BigInt(value)).toBytes());
  const address = moneroAddress(fromHex(point(123)), fromHex(point(456)));
  const target = moneroAddress(fromHex(point(789)), fromHex(point(987)));
  const destination = (
    address: string,
    amount: number
  ): PreparedMoneroTransaction["tsx_data"]["change_dts"] => {
    const keys = moneroPublicKeys(address);
    return {
      amount,
      original: address,
      addr: {
        spend_public_key: toHex(keys.publicSpend),
        view_public_key: toHex(keys.publicView),
      },
      is_subaddress: false,
      is_integrated: false,
    };
  };
  const account: Account = {
    id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    sourceId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    source: "trezor",
    chain: "XMR",
    path: "m/44'/128'/0'",
    address,
    publicKey: moneroPublicKeys(address).publicKey,
    scheme: "native",
    label: "Trezor Model T",
    methods: ["signMoneroTransaction"],
    verifiedAt: 0,
  };
  const change = destination(address, 90);
  const prepared: PreparedMoneroTransaction = {
    format: "trezor-monero-v1",
    networkType: 0,
    keyImages: [point(100)],
    inputs: [
      {
        amount: 200,
        rct: true,
        real_output: 2,
        real_output_in_tx_index: 0,
        real_out_tx_key: point(90),
        real_out_additional_tx_keys: [],
        mask: "01" + "00".repeat(31),
        subaddr_minor: 0,
        outputs: Array.from({ length: 16 }, (_, index) => ({
          idx: 100 + index,
          key: { dest: point(200 + index), commitment: point(300 + index) },
        })),
      },
    ],
    tsx_data: {
      version: 1,
      client_version: 3,
      hard_fork: 16,
      unlock_time: 0,
      outputs: [destination(target, 100), change],
      change_dts: change,
      num_inputs: 1,
      mixin: 15,
      fee: 10,
      account: 0,
      minor_indices: [0],
      integrated_indices: [],
      rsig_data: { rsig_type: 3, bp_version: 4, grouping: [2] },
    },
  };
  const outputs = [`0003${point(400)}01`, `0003${point(401)}02`];
  const extra = `01${point(402)}`;
  // Explicit wire encoding, independent of the adapter's serializers.
  const prefix = `02000102001064${"01".repeat(15)}${point(100)}02${outputs.join("")}21${extra}`;
  const base = `060a${"00".repeat(16)}${point(500)}${point(501)}`;
  const proof = `${point(600).repeat(3)}${"00".repeat(96)}07${point(601).repeat(7)}07${point(602).repeat(7)}`;
  const signature = "01".padEnd(64, "0").repeat(17) + point(603);
  const prunable = `01${proof}${signature}${point(604)}`;
  const opening = "09".repeat(32);
  const derive = (name: string): Buffer => {
    const buffer = Buffer.alloc(48);
    buffer.set(fromHex(opening));
    buffer.write(name, 32, "ascii");
    return Buffer.from(fromHex(keccak256(keccak256(buffer))));
  };
  const cipher = createCipheriv(
    "chacha20-poly1305",
    derive("sig-key"),
    derive("sig-iv").subarray(0, 12),
    { authTagLength: 16 }
  );
  const encrypted = Buffer.concat([
    cipher.update(fromHex(`10${signature}`)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    account,
    prepared,
    device: {
      signatures: [encrypted.toString("hex")],
      tx_prefix_hash: keccak256(`0x${prefix}`).slice(2),
      rv: { txn_fee: 10, rv_type: 6 },
      opening_key: opening,
      pseudo_outs: [point(604)],
      out_pks: [point(400) + point(500), point(401) + point(501)],
      ecdh_infos: ["00".repeat(8), "00".repeat(8)],
      tx_outs: outputs,
      rsig_parts: [proof],
      extra,
    },
    transactionHex: prefix + base + prunable,
    transactionHash: keccak256(
      `0x${[prefix, base, prunable].map((part) => keccak256(`0x${part}`).slice(2)).join("")}`
    ).slice(2),
  };
}
