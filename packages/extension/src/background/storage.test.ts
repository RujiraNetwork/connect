import { EMPTY_STATE } from "@rujira/connect-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChromeStateRepository,
  removeAccount,
  mergeHardwareSources,
  saveRegisteredAccount,
} from "./storage";

import type { Account, StoredState } from "@rujira/connect-core";

describe("persisted state mutations", () => {
  const ledger: Account = {
    id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    sourceId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    source: "ledger",
    chain: "GAIA",
    path: "m/44'/118'/0'/0/0",
    address: "cosmos-fixture",
    publicKey: "public-fixture",
    scheme: "native",
    label: "Ledger",
    methods: ["signAmino"],
    verifiedAt: 0,
  };
  function duplicateState(sameDeviceId: boolean): StoredState {
    const duplicate = {
      ...ledger,
      id: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
      sourceId: "dddddddd-dddd-4ddd-dddd-dddddddddddd",
    };
    return {
      ...structuredClone(EMPTY_STATE),
      sources: [
        {
          id: ledger.sourceId,
          kind: "ledger",
          label: "Ledger",
          deviceId: "old-transport-id",
        },
        {
          id: duplicate.sourceId,
          kind: "ledger",
          label: "Ledger Nano S",
          deviceName: "Ledger Nano S",
          deviceId: sameDeviceId ? "old-transport-id" : "new-transport-id",
        },
      ],
      accounts: [
        ledger,
        duplicate,
        {
          ...duplicate,
          id: "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee",
          chain: "ETH",
          path: "m/44'/60'/0'/0/0",
          address: "eth-fixture",
        },
      ],
      grants: [
        {
          origin: "https://dapp.example",
          accountIds: [
            ledger.id,
            duplicate.id,
            "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee",
          ],
          createdAt: 1,
        },
      ],
    };
  }
  it.each([true, false])(
    "merges duplicate hardware entries and accounts while preserving site permissions (shared transport: %s)",
    (sameDeviceId) => {
      const state = duplicateState(sameDeviceId);
      const result = mergeHardwareSources(state);
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0]).toMatchObject({
        id: ledger.sourceId,
        label: "Ledger Nano S",
        deviceName: "Ledger Nano S",
      });
      expect(result.accounts).toHaveLength(2);
      expect(
        result.accounts.every((account) => account.sourceId === ledger.sourceId)
      ).toBe(true);
      expect(result.grants[0]?.accountIds).toEqual([
        ledger.id,
        "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee",
      ]);
      expect(mergeHardwareSources(result)).toEqual(result);
      expect(state.sources).toHaveLength(2);
    }
  );
  it("keeps separate wallets with the same model and different keys", () => {
    const state = duplicateState(false);
    const distinct = {
      ...state,
      accounts: state.accounts.map((entry) =>
        entry.sourceId === ledger.sourceId
          ? {
              ...entry,
              address: "different-address",
              publicKey: "different-key",
            }
          : entry
      ),
    };
    expect(mergeHardwareSources(distinct).sources).toHaveLength(2);
  });
  it("updates the saved model without adding the same account again", () => {
    const state = mergeHardwareSources(duplicateState(true));
    const result = saveRegisteredAccount(
      state,
      {
        id: ledger.sourceId,
        kind: "ledger",
        label: "Ledger Nano S",
        deviceName: "Ledger Nano S",
        deviceId: "latest-id",
      },
      { ...ledger, id: crypto.randomUUID() }
    );
    expect(result.sources).toHaveLength(1);
    expect(result.accounts).toHaveLength(2);
    expect(result.sources[0]?.deviceId).toBe("latest-id");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("removes one account and its grants without deleting the wallet or its other accounts", () => {
    const account: Account = {
      id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      sourceId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      source: "ledger",
      chain: "BTC",
      address: "fixture",
      path: "m/84'/0'/0'/0/0",
      label: "Bitcoin",
      scheme: "native",
      verifiedAt: 0,
      methods: ["signPsbt"],
    };
    const other = { ...account, id: "cccccccc-cccc-4ccc-cccc-cccccccccccc" };
    const state = {
      ...structuredClone(EMPTY_STATE),
      sources: [
        { id: account.sourceId, label: "Ledger", kind: "ledger" as const },
      ],
      accounts: [account, other],
      grants: [
        {
          origin: "https://both.example",
          accountIds: [account.id, other.id],
          createdAt: 1,
        },
        {
          origin: "https://removed.example",
          accountIds: [account.id],
          createdAt: 1,
        },
        {
          origin: "https://other.example",
          accountIds: [other.id],
          createdAt: 1,
        },
      ],
    };
    const result = removeAccount(state, account.id);
    expect(result.accounts).toEqual([other]);
    expect(result.sources).toEqual(state.sources);
    expect(result.grants).toEqual([
      { ...state.grants[0], accountIds: [other.id] },
      state.grants[2],
    ]);
    expect(state.accounts).toHaveLength(2);
    expect(removeAccount(result, account.id)).toEqual(result);
  });
  it("serializes account changes and permission revocation without restoring a stale grant", async () => {
    let release: (() => void) | undefined;
    let writes = 0;
    const original = {
      ...structuredClone(EMPTY_STATE),
      grants: [
        {
          origin: "https://dapp.example",
          accountIds: ["aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"],
          createdAt: 1,
        },
      ],
    };
    const saved: unknown[] = [];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: () => Promise.resolve({ state: original }),
          set: async (value: unknown) => {
            if (++writes === 1)
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            saved.push(value);
          },
        },
      },
    });
    const repository = new ChromeStateRepository();
    const registration = repository.update((state) => ({
      ...state,
      sources: [
        {
          id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
          kind: "ledger",
          label: "Ledger",
        },
      ],
    }));
    const revocation = repository.update((state) => ({ ...state, grants: [] }));
    await vi.waitFor(() => {
      expect(release).toBeTypeOf("function");
    });
    release?.();
    await Promise.all([registration, revocation]);
    const current = await repository.load();
    expect(current.sources).toHaveLength(1);
    expect(current.grants).toEqual([]);
    expect(saved).toHaveLength(2);
  });
});
