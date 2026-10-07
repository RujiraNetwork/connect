import {
  EMPTY_STATE,
  aminoDocSchema,
  supportedMethods,
} from "@rujira/connect-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WalletDriver } from "./driver";
import { fromHex } from "../adapters/bytes";
import { FIXTURE_SEED, signingFixtures } from "../adapters/fixtures/signing";
import thor from "../adapters/fixtures/thor-eip712.json";
import { addressFor } from "../adapters/keys";
import { signSoftware } from "../adapters/software";
import { verifyResult } from "../adapters/verify";

import type { Account, SignRequest } from "@rujira/connect-core";

const devices = vi.hoisted(() => ({
  ledger:
    vi.fn<
      (
        account: Account,
        request: SignRequest,
        deviceId?: string
      ) => Promise<unknown>
    >(),
  trezor: vi.fn<(account: Account, request: SignRequest) => Promise<unknown>>(),
}));
vi.mock("../adapters/ledger", () => ({
  LedgerAdapter: class {
    sign = devices.ledger;
  },
}));
vi.mock("../adapters/trezor", () => ({
  TrezorAdapter: class {
    sign = devices.trezor;
  },
}));

describe("THORChain Ethereum profile signing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each(["ledger", "trezor"] as const)(
    "binds the approved Amino document to the %s typed-data signature",
    async (source) => {
      const fixture = signingFixtures().find(
        (entry) => entry.account.chain === "ETH"
      );
      if (!fixture) throw new Error("Missing public Ethereum fixture");
      const account: Account = {
        ...fixture.account,
        source,
        chain: "THOR",
        scheme: "eip712",
        address: addressFor(
          "THOR",
          fromHex(fixture.account.publicKey ?? ""),
          fixture.account.path,
          "eip712"
        ),
        methods: [...supportedMethods("THOR", source, "eip712")],
      };
      const request: SignRequest = {
        accountId: account.id,
        chain: "THOR",
        method: "signAmino",
        params: aminoDocSchema.parse(thor.amino),
        typedData: thor.typed,
      };
      const evmRequest: SignRequest = {
        accountId: account.id,
        chain: "ETH",
        method: "eth_signTypedData_v4",
        params: thor.typed,
      };
      const signature = signSoftware(FIXTURE_SEED, fixture.account, evmRequest);
      devices[source].mockResolvedValue(signature);
      const state = {
        ...EMPTY_STATE,
        accounts: [account],
        sources: [
          {
            id: account.sourceId,
            kind: source,
            label: "Public device",
            deviceId: "public-device",
          },
        ],
      };
      const driver = new WalletDriver({
        load: () => Promise.resolve(state),
        update: (change) => Promise.resolve(change(state)),
      });
      verifyResult(
        account,
        request,
        await driver.sign(account, request, "public-digest")
      );
      expect(devices[source]).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: "ETH",
          address: fixture.account.address,
          publicKey: fixture.account.publicKey,
        }),
        evmRequest,
        ...(source === "ledger" ? ["public-device"] : [])
      );
      devices[source].mockClear();
      await expect(
        driver.sign(
          account,
          { ...request, accountId: crypto.randomUUID() },
          "public-digest"
        )
      ).rejects.toThrow();
      expect(devices[source]).not.toHaveBeenCalled();
      const changed = structuredClone(thor.typed);
      changed.message.memo = "unapproved";
      await expect(
        driver.sign(
          account,
          { ...request, typedData: changed },
          "public-digest"
        )
      ).rejects.toThrow("changed");
      expect(devices[source]).not.toHaveBeenCalled();
    }
  );
});
