import {
  EMPTY_STATE,
  ERROR_CODES,
  supportedMethods,
} from "@rujira/connect-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RequestBroker } from "./broker";

import type { RequestContext, StateRepository } from "./broker";
import type { Account, SignRequest, StoredState } from "@rujira/connect-core";

const account: Account = {
  id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  sourceId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  source: "keystore",
  chain: "ETH",
  address: "0x0000000000000000000000000000000000000001",
  path: "m/44'/60'/0'/0/0",
  label: "Test",
  scheme: "native",
  verifiedAt: 0,
  methods: [...supportedMethods("ETH", "keystore")],
};
const sign: SignRequest = {
  accountId: account.id,
  chain: "ETH",
  method: "personal_sign",
  params: { message: "68656c6c6f" },
};
const context: RequestContext = {
  origin: "https://dapp.example",
  documentId: "document-1",
  current: () => Promise.resolve(true),
};

class MemoryRepository implements StateRepository {
  state: StoredState = { ...structuredClone(EMPTY_STATE), accounts: [account] };
  load(): Promise<StoredState> {
    return Promise.resolve(structuredClone(this.state));
  }
  save(state: StoredState): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }
  async update(
    change: (state: StoredState) => StoredState
  ): Promise<StoredState> {
    await this.save(change(this.state));
    return this.load();
  }
}

describe("approval broker", () => {
  let repository: MemoryRepository;
  let broker: RequestBroker;
  let id: string;
  let now: number;
  const signer = vi.fn(() => Promise.resolve("signature"));
  beforeEach(() => {
    id = "";
    now = 1000;
    signer.mockClear();
    repository = new MemoryRepository();
    broker = new RequestBroker(
      repository,
      {
        sign: signer,
        review: () => ({
          title: "Sign",
          fields: [],
          raw: "{}",
          requiresRawAcknowledgement: true,
        }),
      },
      {
        openApproval: (value) => {
          id = value;
          return Promise.resolve(7);
        },
        changed: () => Promise.resolve(),
      },
      () => now
    );
  });
  async function grant(): Promise<void> {
    const response = broker.request(
      { method: "connect", params: { chains: ["ETH"] } },
      context
    );
    await vi.waitFor(() => {
      expect(id).not.toBe("");
    });
    const view = broker.view(id);
    await broker.approve(id, view.digest, [account.id], false);
    await response;
  }
  it("returns no addresses before consent and only explicitly shared addresses afterward", async () => {
    expect(await broker.request({ method: "getAccounts" }, context)).toEqual(
      []
    );
    await grant();
    expect(
      await broker.request({ method: "getAccounts" }, context)
    ).toMatchObject([{ id: account.id }]);
    expect(
      await broker.request(
        { method: "getAccounts" },
        { ...context, origin: "https://other.example" }
      )
    ).toEqual([]);
  });
  it("requires approval for every signature and prevents replay", async () => {
    await grant();
    id = "";
    const response = broker.request({ method: "sign", params: sign }, context);
    await vi.waitFor(() => {
      expect(id).not.toBe("");
    });
    expect(signer).not.toHaveBeenCalled();
    const view = broker.view(id);
    await broker.approve(id, view.digest, [], true);
    await expect(response).resolves.toMatchObject({ payload: "signature" });
    await expect(
      broker.approve(id, view.digest, [], true)
    ).rejects.toMatchObject({ code: ERROR_CODES.expired });
    expect(signer).toHaveBeenCalledTimes(1);
  });
  it("cancels a pending request when an account in its summary is removed", async () => {
    await grant();
    id = "";
    const request = broker.request({ method: "sign", params: sign }, context);
    const rejected = expect(request).rejects.toMatchObject({
      code: ERROR_CODES.unauthorized,
    });
    await vi.waitFor(() => {
      expect(id).not.toBe("");
    });
    const view = broker.view(id);
    expect(view.accounts[0]?.path).toBe(account.path);
    broker.accountRemoved(account.id);
    await rejected;
    await expect(
      broker.approve(id, view.digest, [account.id], true)
    ).rejects.toMatchObject({ code: ERROR_CODES.expired });
    expect(signer).not.toHaveBeenCalled();
  });
  it("rejects forged consent digests without signing", async () => {
    await grant();
    id = "";
    const response = broker.request({ method: "sign", params: sign }, context);
    const assertion = expect(response).rejects.toMatchObject({
      code: ERROR_CODES.invalid,
    });
    await vi.waitFor(() => {
      expect(id).not.toBe("");
    });
    await expect(broker.approve(id, "0".repeat(64), [], true)).rejects.toThrow(
      "displayed"
    );
    await assertion;
    expect(signer).not.toHaveBeenCalled();
  });
  it("requires raw-data acknowledgement", async () => {
    await grant();
    id = "";
    const response = broker.request({ method: "sign", params: sign }, context);
    const assertion = expect(response).rejects.toMatchObject({
      code: ERROR_CODES.invalid,
    });
    await vi.waitFor(() => {
      expect(id).not.toBe("");
    });
    await expect(
      broker.approve(id, broker.view(id).digest, [], false)
    ).rejects.toThrow("Acknowledge");
    await assertion;
  });
  it("rejects expired requests and document navigation", async () => {
    await grant();
    id = "";
    const response = broker.request({ method: "sign", params: sign }, context);
    const assertion = expect(response).rejects.toMatchObject({
      code: ERROR_CODES.expired,
    });
    await vi.waitFor(() => {
      expect(id).not.toBe("");
    });
    const digest = broker.view(id).digest;
    now += 300_001;
    await expect(broker.approve(id, digest, [], true)).rejects.toThrow(
      "expired"
    );
    await assertion;
    expect(signer).not.toHaveBeenCalled();
    id = "";
    const navigated = broker.request(
      { method: "connect", params: { chains: ["ETH"] } },
      context
    );
    const rejected = expect(navigated).rejects.toMatchObject({
      code: ERROR_CODES.disconnected,
    });
    await vi.waitFor(() => {
      expect(id).not.toBe("");
    });
    broker.documentClosed(context.documentId);
    await rejected;
  });
  it("rejects parallel prompts and window closure", async () => {
    const response = broker.request(
      { method: "connect", params: { chains: ["ETH"] } },
      context
    );
    const assertion = expect(response).rejects.toMatchObject({
      code: ERROR_CODES.rejected,
    });
    await vi.waitFor(() => {
      expect(id).not.toBe("");
    });
    await expect(
      broker.request(
        { method: "connect", params: { chains: ["ETH"] } },
        context
      )
    ).rejects.toMatchObject({ code: ERROR_CODES.busy });
    broker.windowClosed(7);
    await assertion;
  });
  it("does not retain permissions after disconnect", async () => {
    await grant();
    await broker.request({ method: "disconnect" }, context);
    await expect(
      broker.request({ method: "sign", params: sign }, context)
    ).rejects.toThrow("not permitted");
  });
});
