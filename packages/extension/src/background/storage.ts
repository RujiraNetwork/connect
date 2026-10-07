import {
  EMPTY_STATE,
  chainSchema,
  sourceKindSchema,
  stateSchema,
  supportedMethods,
} from "@rujira/connect-core";
import { z } from "zod";

import type { StateRepository } from "./broker";
import type { StoredState, Account, WalletSource } from "@rujira/connect-core";

/** Preserve registered addresses and grants when retiring native-host capabilities. */
export function migrateStoredState(value: unknown): StoredState {
  const previous = z
    .object({
      accounts: z.array(
        z.object({ chain: chainSchema, source: sourceKindSchema }).passthrough()
      ),
    })
    .passthrough()
    .parse(value);
  return stateSchema.parse({
    ...previous,
    accounts: previous.accounts.map((account) =>
      account.chain === "XMR"
        ? { ...account, methods: [...supportedMethods("XMR", account.source)] }
        : account
    ),
  });
}

function sameHardwareWallet(
  state: StoredState,
  left: WalletSource,
  right: WalletSource
): boolean {
  if (left.kind === "keystore" || left.kind !== right.kind) return false;
  if (left.deviceId && left.deviceId === right.deviceId) return true;
  return state.accounts.some(
    (a) =>
      a.sourceId === left.id &&
      a.publicKey &&
      state.accounts.some(
        (b) =>
          b.sourceId === right.id &&
          a.chain === b.chain &&
          a.path === b.path &&
          a.publicKey === b.publicKey &&
          a.address === b.address
      )
  );
}

/** Merge only a shared transport identity or a matching, verified wallet key. */
export function mergeHardwareSources(state: StoredState): StoredState {
  const sources: WalletSource[] = [];
  const sourceIds = new Map<string, string>();
  for (const source of state.sources) {
    const existing = sources.find((entry) =>
      sameHardwareWallet(state, entry, source)
    );
    if (!existing) {
      sources.push({ ...source });
      sourceIds.set(source.id, source.id);
      continue;
    }
    sourceIds.set(source.id, existing.id);
    if (source.deviceName) {
      existing.deviceName = source.deviceName;
      existing.label = source.deviceName;
    }
    if (source.deviceId) existing.deviceId = source.deviceId;
  }
  const accounts: Account[] = [];
  const accountIds = new Map<string, string>();
  for (const account of state.accounts) {
    const sourceId = sourceIds.get(account.sourceId) ?? account.sourceId;
    const existing = accounts.find(
      (entry) =>
        entry.sourceId === sourceId &&
        entry.chain === account.chain &&
        entry.path === account.path &&
        entry.address === account.address &&
        entry.scheme === account.scheme
    );
    accountIds.set(account.id, existing?.id ?? account.id);
    if (!existing) accounts.push({ ...account, sourceId });
  }
  const merged: StoredState = {
    ...state,
    sources,
    accounts,
    grants: state.grants.map((grant) => ({
      ...grant,
      accountIds: [
        ...new Set(grant.accountIds.map((id) => accountIds.get(id) ?? id)),
      ],
    })),
  };
  return sources.length < state.sources.length
    ? mergeHardwareSources(merged)
    : merged;
}

export function saveRegisteredAccount(
  state: StoredState,
  source: WalletSource,
  account: Account
): StoredState {
  const sources = state.sources.some((entry) => entry.id === source.id)
    ? state.sources.map((entry) => (entry.id === source.id ? source : entry))
    : [...state.sources, source];
  return mergeHardwareSources({
    ...state,
    sources,
    accounts: [...state.accounts, account],
  });
}

export function removeAccount(
  state: StoredState,
  accountId: string
): StoredState {
  return {
    ...state,
    accounts: state.accounts.filter((account) => account.id !== accountId),
    grants: state.grants
      .map((grant) => ({
        ...grant,
        accountIds: grant.accountIds.filter((id) => id !== accountId),
      }))
      .filter((grant) => grant.accountIds.length > 0),
  };
}

export class ChromeStateRepository implements StateRepository {
  private state: Promise<StoredState> | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  load(): Promise<StoredState> {
    this.state ??= chrome.storage.local
      .get("state")
      .then((stored) =>
        stored.state === undefined
          ? structuredClone(EMPTY_STATE)
          : mergeHardwareSources(migrateStoredState(stored.state))
      );
    return this.state.then((state) => structuredClone(state));
  }
  private async save(state: StoredState): Promise<void> {
    const parsed = stateSchema.parse(state);
    await chrome.storage.local.set({ state: parsed });
    this.state = Promise.resolve(parsed);
  }
  update(change: (state: StoredState) => StoredState): Promise<StoredState> {
    const next = this.writes.then(async () => {
      const state = stateSchema.parse(change(await this.load()));
      await this.save(state);
      return structuredClone(state);
    });
    this.writes = next.catch(() => undefined);
    return next;
  }
}
