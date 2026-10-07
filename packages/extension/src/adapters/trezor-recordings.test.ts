import {
  CHAINS,
  accountSchema,
  signRequestSchema,
  supportedMethods,
} from "@rujira/connect-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import recorded from "./fixtures/trezor-signing.json";
import { verifyMoneroCryptography, wipeMoneroKernel } from "./monero-crypto";
import { verifyResult } from "./verify";

const fixtures = z
  .array(
    z.object({
      account: accountSchema,
      request: signRequestSchema,
      signed: z.unknown(),
    })
  )
  .parse(recorded);

describe("published Trezor firmware signing recordings", () => {
  it("covers every advertised native method", () => {
    for (const chain of Object.values(CHAINS))
      expect(
        fixtures
          .filter((entry) => entry.account.chain === chain.id)
          .map((entry) => entry.request.method)
          .sort()
      ).toEqual([...supportedMethods(chain.id, "trezor")].sort());
  });
  it.each(fixtures)(
    "verifies $account.chain / $request.method against the public registered account",
    ({ account, request, signed }) => {
      verifyResult(account, request, signed);
      if (request.method === "signMoneroTransaction") {
        try {
          verifyMoneroCryptography(request.params, signed);
        } finally {
          wipeMoneroKernel();
        }
      }
      expect(() => {
        verifyResult(
          { ...account, address: "wrong-device", publicKey: "wrong-device" },
          request,
          signed
        );
      }).toThrow();
      if (request.method === "signSolanaMessage")
        expect(() => {
          verifyResult(
            account,
            { ...request, params: { message: "68656c6c6f21" } },
            signed
          );
        }).toThrow();
      if (request.method === "signXrpTransaction")
        expect(() => {
          verifyResult(
            account,
            { ...request, params: { ...request.params, Flags: 1 } },
            signed
          );
        }).toThrow();
    }
  );
});
