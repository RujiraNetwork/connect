import { ed25519 } from "@noble/curves/ed25519";
import { z } from "zod";

import { toHex } from "../bytes";
import {
  hashScalar,
  scalarValue,
  moneroCommitment,
  scalarBytes,
} from "../monero-crypto";
import { software_images, software_output } from "../monero-kernel/kernel";
import { moneroAddress, moneroPublicKeys } from "../monero-keys";

import type {
  Account,
  PreparedMoneroTransaction,
  SourceKind,
} from "@rujira/connect-core";

/** Spendable offline RingCT outputs for public test keys, with sixteen-member rings. */
export function nativeMoneroFixture(
  spend: Uint8Array,
  view: Uint8Array,
  source: SourceKind = "keystore",
  real = 2,
  minor = 0,
  nonce = 90
): { account: Account; prepared: PreparedMoneroTransaction } {
  const point = (value: number): Uint8Array =>
    ed25519.Point.BASE.multiply(BigInt(value)).toBytes();
  const address = moneroAddress(
    ed25519.Point.BASE.multiply(
      BigInt(`0x${toHex(new Uint8Array(spend).reverse())}`)
    ).toBytes(),
    ed25519.Point.BASE.multiply(
      BigInt(`0x${toHex(new Uint8Array(view).reverse())}`)
    ).toBytes()
  );
  const target = moneroAddress(point(789), point(987));
  const destination = (
    original: string,
    amount: number
  ): PreparedMoneroTransaction["tsx_data"]["change_dts"] => {
    const keys = moneroPublicKeys(original);
    return {
      original,
      amount,
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
    source,
    chain: "XMR",
    path: source === "ledger" ? "device" : "m/44'/128'/0'",
    address,
    publicKey: moneroPublicKeys(address).publicKey,
    label: "Public test wallet",
    scheme: "native",
    verifiedAt: 0,
    methods: ["signMoneroTransaction"],
  };
  const commitment = moneroCommitment(scalarBytes(1n), 200);
  const own = moneroPublicKeys(address);
  let publicSpend = own.publicSpend;
  if (minor !== 0) {
    const index = new Uint8Array(8);
    new DataView(index.buffer).setUint32(4, minor, true);
    const offset = hashScalar(
      new Uint8Array([
        ...new TextEncoder().encode("SubAddr\0"),
        ...view,
        ...index,
      ])
    );
    publicSpend = ed25519.Point.fromBytes(publicSpend)
      .add(ed25519.Point.BASE.multiply(scalarValue(offset)))
      .toBytes();
  }
  const output = software_output(
    scalarBytes(BigInt(nonce)),
    toHex(own.publicView),
    toHex(publicSpend),
    0,
    "200"
  );
  const input: PreparedMoneroTransaction["inputs"][number] = {
    amount: 200,
    rct: true,
    real_output: real,
    real_output_in_tx_index: 0,
    real_out_tx_key: toHex(point(nonce)),
    real_out_additional_tx_keys: [],
    mask: toHex(scalarBytes(1n)),
    subaddr_minor: minor,
    outputs: Array.from({ length: 16 }, (_, index) => ({
      idx: 100 + index,
      key: {
        dest: toHex(index === real ? output.slice(2, 34) : point(200 + index)),
        commitment: toHex(
          index === real
            ? commitment
            : moneroCommitment(scalarBytes(BigInt(2 + index)), 200)
        ),
      },
    })),
  };
  const images = z
    .array(z.string())
    .parse(JSON.parse(software_images(spend, view, JSON.stringify([input]))));
  const change = destination(address, 90);
  return {
    account,
    prepared: {
      format: "monero-prepared-v1",
      networkType: 0,
      inputs: [input],
      keyImages: images,
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
        minor_indices: [minor],
        integrated_indices: [],
        rsig_data: { rsig_type: 3, bp_version: 4, grouping: [2] },
      },
    },
  };
}
