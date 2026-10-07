import { describe, expect, it } from "vitest";

import {
  MAX_ACCOUNT_INDEX,
  accountIndexLimit,
  accountPath,
  isDefaultAccountPath,
  validateLedgerAccountPath,
  supportedMethods,
} from "./chains";
import { uiRequestSchema } from "./ui";

describe("account paths and device limits", () => {
  it("advertises only implemented browser Monero signing methods", () => {
    expect(supportedMethods("XMR", "ledger")).toEqual([
      "signMoneroTransaction",
    ]);
    expect(supportedMethods("XMR", "keystore")).toEqual([
      "signMoneroTransaction",
    ]);
    expect(supportedMethods("XMR", "trezor")).toEqual([
      "signMoneroTransaction",
    ]);
  });
  it("enforces Ledger Bitcoin's default-wallet limit in both paths and UI requests", () => {
    expect(accountIndexLimit("BTC", "ledger")).toBe(100);
    expect(accountPath("BTC", 100, "ledger")).toBe("m/84'/0'/100'/0/0");
    expect(accountPath("BTC", 100, "ledger", "legacy")).toBe(
      "m/44'/0'/100'/0/0"
    );
    for (const index of [-1, 0.5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => accountPath("BTC", index, "ledger")).toThrow();
      expect(
        uiRequestSchema.safeParse({
          action: "register",
          source: "ledger",
          chain: "BTC",
          accountIndex: index,
          profile: "default",
        }).success
      ).toBe(false);
    }
    expect(
      uiRequestSchema.safeParse({
        action: "register",
        source: "ledger",
        chain: "BTC",
        accountIndex: 100,
        profile: "legacy",
      }).success
    ).toBe(true);
  });

  it("does not impose Bitcoin's device-policy limit on other sources or apps", () => {
    expect(accountPath("BTC", 101, "keystore")).toBe("m/84'/0'/101'/0/0");
    expect(accountPath("BTC", 101, "trezor")).toBe("m/84'/0'/101'/0/0");
    expect(accountPath("ETH", 101, "ledger")).toBe("m/44'/60'/101'/0/0");
    expect(accountPath("SOL", MAX_ACCOUNT_INDEX, "ledger")).toBe(
      `m/44'/501'/${String(MAX_ACCOUNT_INDEX)}'/0'`
    );
    expect(() => accountPath("ETH", MAX_ACCOUNT_INDEX + 1, "ledger")).toThrow();
  });

  it("validates persisted Ledger paths before device access", () => {
    expect(() => {
      validateLedgerAccountPath({
        chain: "BTC",
        scheme: "native",
        path: "m/84'/0'/101'/0/0",
      });
    }).toThrow("0 to 100");
    expect(() => {
      validateLedgerAccountPath({
        chain: "BTC",
        scheme: "native",
        path: "m/84'/0'/0'/1/0",
      });
    }).toThrow("unsupported Ledger path");
    expect(() => {
      validateLedgerAccountPath({
        chain: "BTC",
        scheme: "native",
        path: "m/84'/1'/0'/0/0",
      });
    }).toThrow("unsupported Ledger path");
    expect(() => {
      validateLedgerAccountPath({
        chain: "THOR",
        scheme: "eip712",
        path: "m/44'/60'/2'/0/0",
      });
    }).not.toThrow();
    expect(() => {
      validateLedgerAccountPath({
        chain: "XMR",
        scheme: "native",
        path: "device",
      });
    }).not.toThrow();
  });

  it("shows changed accounts and profiles while keeping source-specific defaults quiet", () => {
    expect(
      isDefaultAccountPath({
        chain: "BTC",
        source: "ledger",
        path: "m/84'/0'/0'/0/0",
      })
    ).toBe(true);
    expect(
      isDefaultAccountPath({
        chain: "BTC",
        source: "ledger",
        path: "m/84'/0'/1'/0/0",
      })
    ).toBe(false);
    expect(
      isDefaultAccountPath({
        chain: "BTC",
        source: "ledger",
        path: "m/44'/0'/0'/0/0",
      })
    ).toBe(false);
    expect(
      isDefaultAccountPath({
        chain: "THOR",
        source: "trezor",
        path: "m/44'/60'/0'/0/0",
      })
    ).toBe(false);
    expect(
      isDefaultAccountPath({
        chain: "XMR",
        source: "ledger",
        path: "device",
      })
    ).toBe(true);
  });
  it("uses Ledger's on-device Monero wallet selection and keeps Trezor's hardened paths", () => {
    expect(accountPath("XMR", 0, "ledger")).toBe("device");
    expect(() => accountPath("XMR", 1, "ledger")).toThrow(
      "selected in the Ledger app"
    );
    expect(accountPath("XMR", 2, "trezor")).toBe("m/44'/128'/2'");
    expect(
      uiRequestSchema.safeParse({
        action: "register",
        chain: "XMR",
        source: "ledger",
        accountIndex: 1,
        profile: "default",
      }).success
    ).toBe(false);
  });
});
