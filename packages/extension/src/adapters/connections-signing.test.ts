import { CHAINS, supportedMethods } from "@rujira/connect-core";
import { describe, expect, it, vi } from "vitest";

import { FIXTURE_SEED, signingFixtures } from "./fixtures/signing";
import { signSoftware } from "./software";
import { verifyResult } from "./verify";

const fixtures = signingFixtures();
describe("every registered network and signing method", () => {
  it("covers the complete keystore capability registry", () => {
    for (const chain of Object.values(CHAINS))
      expect(
        fixtures
          .filter((fixture) => fixture.account.chain === chain.id)
          .map((fixture) => fixture.request.method)
          .sort()
      ).toEqual([...supportedMethods(chain.id, "keystore")].sort());
  });
  it.each(fixtures)(
    "registers and signs $account.chain / $request.method offline",
    ({ account, request, signed }) => {
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("Signing cannot use a network");
      });
      verifyResult(account, request, signed);
      expect(() =>
        signSoftware(FIXTURE_SEED, account, {
          ...request,
          accountId: crypto.randomUUID(),
        })
      ).toThrow();
      expect(() =>
        signSoftware(
          FIXTURE_SEED,
          { ...account, address: "wrong-wallet" },
          request
        )
      ).toThrow();
      expect(network).not.toHaveBeenCalled();
    }
  );
});
