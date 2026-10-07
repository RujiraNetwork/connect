import { mnemonicToSeedSync } from "@scure/bip39";
import { describe, expect, it, vi } from "vitest";

import { fromHex } from "./bytes";
import { nativeMoneroFixture } from "./fixtures/monero-native";
import { signMoneroSoftware, verifyMoneroCryptography } from "./monero-crypto";
import { moneroKeys } from "./monero-keys";
import { verifyMoneroTransaction } from "./monero-transactions";
import { signSoftware } from "./software";

const seed = mnemonicToSeedSync(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
);
const keys = moneroKeys(seed, "m/44'/128'/0'");
function fixture(real = 2) {
  return nativeMoneroFixture(
    fromHex(keys.spendKey),
    fromHex(keys.viewKey),
    "keystore",
    real
  );
}

describe("offline Monero keystore signing", () => {
  it.each([0, 2, 15])(
    "signs and verifies a native BP+ transaction with real ring index %s",
    (real) => {
      const { account, prepared } = fixture(real);
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("No network in signing");
      });
      const signed = signSoftware(seed, account, {
        accountId: account.id,
        chain: "XMR",
        method: "signMoneroTransaction",
        params: prepared,
      });
      verifyMoneroTransaction(account, prepared, signed);
      expect(network).not.toHaveBeenCalled();
    }
  );
  it("signs multiple inputs, minor subaddresses and additional transaction keys", () => {
    const { account, prepared } = fixture();
    const additional = nativeMoneroFixture(
      fromHex(keys.spendKey),
      fromHex(keys.viewKey),
      "keystore",
      15,
      7,
      91
    ).prepared;
    const input = additional.inputs[0];
    if (!input) throw new Error("Missing fixture input");
    input.real_out_additional_tx_keys = [input.real_out_tx_key];
    input.real_out_tx_key = prepared.inputs[0]?.real_out_tx_key ?? "";
    const inputs = [...prepared.inputs, input]
      .map((entry, index) => ({
        input: entry,
        image: [...prepared.keyImages, ...additional.keyImages][index] ?? "",
      }))
      .toSorted((left, right) => right.image.localeCompare(left.image));
    prepared.inputs = inputs.map((entry) => entry.input);
    prepared.keyImages = inputs.map((entry) => entry.image);
    prepared.tsx_data.num_inputs = 2;
    prepared.tsx_data.minor_indices = [0, 7];
    const recipient = prepared.tsx_data.outputs[0];
    if (!recipient) throw new Error("No recipient");
    recipient.amount = 300;
    const signed = signMoneroSoftware(seed, account, prepared);
    verifyMoneroCryptography(prepared, signed);
    const changed = {
      ...signed,
      transactionHex: signed.transactionHex.slice(0, -2) + "ff",
    };
    expect(() => {
      verifyMoneroCryptography(prepared, changed);
    }).toThrow("proof or signature");
  });
  it("rejects another keystore, wrong key images, and dishonest commitments", () => {
    const { account, prepared } = fixture();
    expect(() =>
      signMoneroSoftware(new Uint8Array(64).fill(7), account, prepared)
    ).toThrow("does not match");
    const changed = structuredClone(prepared);
    changed.keyImages[0] = changed.inputs[0]?.outputs[0]?.key.dest ?? "";
    expect(() => signMoneroSoftware(seed, account, changed)).toThrow(
      "key image"
    );
    const commitment = structuredClone(prepared);
    const input = commitment.inputs[0];
    if (!input) throw new Error("No fixture input");
    input.mask = "02" + "00".repeat(31);
    expect(() => signMoneroSoftware(seed, account, commitment)).toThrow();
  });
  it("rejects altered fees, recipients, change and unsupported preparation before signing", () => {
    const { account, prepared } = fixture();
    for (const mutate of [
      (tx: typeof prepared) => {
        tx.tsx_data.fee++;
      },
      (tx: typeof prepared) => {
        tx.tsx_data.change_dts.original =
          tx.tsx_data.outputs[0]?.original ?? "";
      },
      (tx: typeof prepared) => {
        tx.inputs.reverse();
        tx.keyImages.push(tx.keyImages[0] ?? "");
      },
    ]) {
      const changed = structuredClone(prepared);
      mutate(changed);
      expect(() => signMoneroSoftware(seed, account, changed)).toThrow();
    }
  });
});
