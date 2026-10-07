import {
  preparedMoneroTransactionSchema,
  signRequestSchema,
} from "@rujira/connect-core";
import { describe, expect, it } from "vitest";

import { moneroFixture } from "./fixtures/monero";
import {
  assembleMoneroTransaction,
  validateMoneroTransaction,
  verifyMoneroTransaction,
} from "./monero-transactions";
import { reviewRequest } from "./review";

describe("offline prepared Monero transactions", () => {
  it("decodes authenticated device signatures into the exact native transaction bytes", () => {
    const fixture = moneroFixture();
    const signed = assembleMoneroTransaction(
      fixture.account,
      fixture.prepared,
      fixture.device
    );
    expect(signed).toEqual({
      transactionHex: fixture.transactionHex,
      transactionHash: fixture.transactionHash,
      amount: "100",
      fee: "10",
    });
    expect(() => {
      verifyMoneroTransaction(fixture.account, fixture.prepared, signed);
    }).not.toThrow();
    const review = reviewRequest(fixture.account, {
      accountId: fixture.account.id,
      chain: "XMR",
      method: "signMoneroTransaction",
      params: fixture.prepared,
    });
    expect(review.fields).toContainEqual({
      label: "Recipient",
      value: fixture.prepared.tsx_data.outputs[0]?.original,
    });
    expect(review.fields).toContainEqual({
      label: "Fee",
      value: "0.00000000001 XMR",
    });
  });
  it("rejects destination-only requests and any RPC or preparation settings", () => {
    expect(
      signRequestSchema.safeParse({
        accountId: crypto.randomUUID(),
        chain: "XMR",
        method: "signMoneroTransfer",
        params: {
          destinations: [],
          priority: 1,
          restoreHeight: 0,
          maxFee: "100",
        },
      }).success
    ).toBe(false);
    const { prepared } = moneroFixture();
    for (const extra of [
      { node: "https://example.com" },
      { restoreHeight: 0 },
      { priority: 1 },
      { memo: "text" },
    ])
      expect(
        preparedMoneroTransactionSchema.safeParse({ ...prepared, ...extra })
          .success
      ).toBe(false);
    expect(
      preparedMoneroTransactionSchema.safeParse({ ...prepared, networkType: 1 })
        .success
    ).toBe(false);
    expect(
      preparedMoneroTransactionSchema.safeParse({
        ...prepared,
        tsx_data: { ...prepared.tsx_data, fee: Number.MAX_SAFE_INTEGER + 1 },
      }).success
    ).toBe(false);
    expect(
      preparedMoneroTransactionSchema.safeParse({
        ...prepared,
        tsx_data: {
          ...prepared.tsx_data,
          outputs: [...prepared.tsx_data.outputs, prepared.tsx_data.change_dts],
        },
      }).success
    ).toBe(false);
  });
  it("binds amounts and change to the registered address before opening a device", () => {
    const { account, prepared } = moneroFixture();
    const changed = structuredClone(prepared);
    changed.tsx_data.fee++;
    expect(() => {
      validateMoneroTransaction(account, changed);
    }).toThrow("cover the outputs");
    const wrongChange = structuredClone(prepared);
    wrongChange.tsx_data.change_dts =
      wrongChange.tsx_data.outputs[0] ?? wrongChange.tsx_data.change_dts;
    expect(() => {
      validateMoneroTransaction(account, wrongChange);
    }).toThrow("registered account");
    const wrongAddress = structuredClone(prepared);
    wrongAddress.tsx_data.change_dts.addr.spend_public_key = "00".repeat(32);
    expect(() => {
      validateMoneroTransaction(account, wrongAddress);
    }).toThrow("does not match");
    expect(() => {
      validateMoneroTransaction({ ...account, chain: "BTC" }, prepared);
    }).toThrow("Monero account");
  });
  it("rejects incomplete, unordered, and duplicate input data", () => {
    const { account, prepared } = moneroFixture();
    expect(() => {
      validateMoneroTransaction(account, { ...prepared, keyImages: [] });
    }).toThrow();
    const unordered = structuredClone(prepared);
    const first = unordered.inputs[0];
    if (!first) throw new Error("Missing input fixture");
    first.outputs.reverse();
    expect(() => {
      validateMoneroTransaction(account, unordered);
    }).toThrow("increasing output indices");
    const duplicate = structuredClone(prepared);
    const source = duplicate.inputs[0];
    if (!source) throw new Error("Missing input fixture");
    duplicate.inputs.push(source);
    duplicate.keyImages.push(duplicate.keyImages[0] ?? "");
    duplicate.tsx_data.num_inputs = 2;
    expect(() => {
      validateMoneroTransaction(account, duplicate);
    }).toThrow("unique key images");
  });
  it("rejects altered device fees, input hashes, and unauthenticated signatures", () => {
    const fixture = moneroFixture();
    expect(() =>
      assembleMoneroTransaction(fixture.account, fixture.prepared, {
        ...fixture.device,
        rv: { rv_type: 6, txn_fee: 11 },
      })
    ).toThrow("fee");
    expect(() =>
      assembleMoneroTransaction(fixture.account, fixture.prepared, {
        ...fixture.device,
        tx_prefix_hash: "00".repeat(32),
      })
    ).toThrow("prepared inputs");
    expect(() =>
      assembleMoneroTransaction(fixture.account, fixture.prepared, {
        ...fixture.device,
        signatures: ["00".repeat(593)],
      })
    ).toThrow();
    const signed = assembleMoneroTransaction(
      fixture.account,
      fixture.prepared,
      fixture.device
    );
    expect(() => {
      verifyMoneroTransaction(fixture.account, fixture.prepared, {
        ...signed,
        transactionHash: "00".repeat(32),
      });
    }).toThrow("hash");
  });
});
