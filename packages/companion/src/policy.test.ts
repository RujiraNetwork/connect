import { accountPath, supportedMethods } from "@rujira/connect-core";
import { describe, expect, it } from "vitest";

import { validateMoneroAccount, validateNode } from "./policy";

import type { Account, SignRequest } from "@rujira/connect-core";

const account: Account = {
  id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  sourceId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  source: "trezor",
  chain: "XMR",
  address: "4".repeat(95),
  path: accountPath("XMR", 0, "trezor"),
  label: "Monero",
  scheme: "native",
  verifiedAt: 1,
  methods: [...supportedMethods("XMR", "trezor")],
};
const transfer: Extract<SignRequest, { method: "signMoneroTransfer" }> = {
  accountId: account.id,
  chain: "XMR",
  method: "signMoneroTransfer",
  params: {
    destinations: [{ address: account.address, amount: "100000000000" }],
    priority: 1,
    accountIndex: 0,
    restoreHeight: 0,
    maxFee: "1000000000",
  },
};
describe("native Monero request policy", () => {
  it("accepts TLS nodes and loopback HTTP without credentials or paths", () => {
    expect(validateNode("https://node.example:18081/")).toBe(
      "https://node.example:18081"
    );
    expect(validateNode("http://127.0.0.1:18081")).toBe(
      "http://127.0.0.1:18081"
    );
    for (const node of [
      "http://node.example:18081",
      "https://user:password@node.example",
      "https://node.example/json_rpc",
      "https://node.example?key=secret",
    ])
      expect(() => validateNode(node)).toThrow();
  });
  it("binds the native operation to the stored account and approved fee", () => {
    expect(() => {
      validateMoneroAccount(account, account, transfer, transfer.params.maxFee);
    }).not.toThrow();
    expect(() => {
      validateMoneroAccount(
        account,
        { ...account, address: "5".repeat(95) },
        transfer,
        transfer.params.maxFee
      );
    }).toThrow("registered");
    expect(() => {
      validateMoneroAccount(account, account, transfer, "2000000000");
    }).toThrow("exact maximum");
  });
  it("rejects memos, hidden account switching, and zero amounts", () => {
    for (const params of [
      { ...transfer.params, memo: "SWAP:BTC.BTC" },
      { ...transfer.params, accountIndex: 1 },
      {
        ...transfer.params,
        destinations: [{ address: account.address, amount: "0" }],
      },
    ])
      expect(() => {
        validateMoneroAccount(
          account,
          account,
          { ...transfer, params },
          transfer.params.maxFee
        );
      }).toThrow();
  });
});
