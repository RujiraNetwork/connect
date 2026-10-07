import { describe, expect, it } from "vitest";

import { accountPath, supportedMethods } from "./chains";
import {
  accountSchema,
  publicRequestSchema,
  signRequestSchema,
} from "./protocol";
import {
  authorizeSign,
  canonicalJson,
  originOf,
  payloadDigest,
  validateSignAccount,
} from "./security";

const account = accountSchema.parse({
  id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  sourceId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  source: "keystore",
  chain: "ETH",
  address: "0x0000000000000000000000000000000000000001",
  path: "m/44'/60'/0'/0/0",
  label: "Test",
  scheme: "native",
  verifiedAt: 0,
  methods: supportedMethods("ETH", "keystore"),
});
const request = signRequestSchema.parse({
  accountId: account.id,
  chain: "ETH",
  method: "eth_signTransaction",
  params: {
    chainId: "0x1",
    nonce: 0,
    gasLimit: "21000",
    gasPrice: "1",
    from: account.address,
    to: account.address,
    value: "1",
  },
});

describe("origin and signing boundaries", () => {
  it("accepts HTTPS and explicit local development origins", () => {
    expect(originOf("https://app.rujira.network/path")).toBe(
      "https://app.rujira.network"
    );
    expect(originOf("http://localhost:5174/path")).toBe(
      "http://localhost:5174"
    );
    expect(() => originOf("http://example.com")).toThrow();
    expect(() => originOf("data:text/plain,hello")).toThrow();
  });
  it("does not share signing permissions with a subdomain or another port", () => {
    const grants = [
      {
        origin: "https://app.rujira.network",
        accountIds: [account.id],
        createdAt: 0,
      },
    ];
    expect(
      authorizeSign(grants[0]?.origin ?? "", request, [account], grants)
    ).toEqual(account);
    expect(() =>
      authorizeSign(
        "https://evil.app.rujira.network",
        request,
        [account],
        grants
      )
    ).toThrow("not permitted");
    expect(() =>
      authorizeSign(
        "https://app.rujira.network:444",
        request,
        [account],
        grants
      )
    ).toThrow("not permitted");
  });
  it("rejects mismatched networks, senders, and methods", () => {
    expect(() => {
      validateSignAccount(
        account,
        signRequestSchema.parse({ ...request, chain: "BASE" })
      );
    }).toThrow("network");
    if (request.method !== "eth_signTransaction")
      throw new Error("Invalid fixture");
    expect(() => {
      validateSignAccount(account, {
        ...request,
        params: { ...request.params, chainId: "8453" },
      });
    }).toThrow("chain ID");
    expect(() => {
      validateSignAccount(account, {
        ...request,
        params: {
          ...request.params,
          from: "0x0000000000000000000000000000000000000002",
        },
      });
    }).toThrow("sender");
    expect(() => {
      validateSignAccount({ ...account, methods: [] }, request);
    }).toThrow("method");
  });
  it("does not accept a broadcast operation or a request with injected fields", () => {
    expect(
      publicRequestSchema.safeParse({
        method: "eth_sendTransaction",
        params: {},
      }).success
    ).toBe(false);
    expect(
      signRequestSchema.safeParse({ ...request, origin: "https://forged.test" })
        .success
    ).toBe(false);
  });
  it("uses deterministic digests and rejects non-JSON values", async () => {
    expect(await payloadDigest({ a: 1, b: 2 })).toBe(
      await payloadDigest({ b: 2, a: 1 })
    );
    expect(await payloadDigest({ a: 2 })).not.toBe(
      await payloadDigest({ a: 1 })
    );
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson(NaN)).toThrow();
  });
  it("uses the correct account segment and capability differences", () => {
    expect(accountPath("BTC", 7, "ledger")).toBe("m/84'/0'/7'/0/0");
    expect(accountPath("THOR", 1, "trezor", "evm")).toBe("m/44'/60'/1'/0/0");
    expect(accountPath("XMR", 0, "ledger")).toBe("device");
    expect(supportedMethods("THOR", "trezor")).toEqual([]);
    expect(supportedMethods("THOR", "trezor", "eip712")).toEqual(["signAmino"]);
    expect(supportedMethods("GAIA", "ledger")).not.toContain("signDirect");
  });
});
