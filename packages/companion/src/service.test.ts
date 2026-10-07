import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompanionService } from "./service";

import type { Account, CompanionRequest } from "@rujira/connect-core";

const engine = vi.hoisted(() => ({
  provisionHardware: vi.fn(),
  call: vi.fn(),
  close: vi.fn(),
}));
vi.mock("./engine", () => ({
  NativeWalletEngine: class {
    provisionHardware = engine.provisionHardware;
    close = engine.close;
    open(): Promise<{ call: typeof engine.call }> {
      return Promise.resolve({ call: engine.call });
    }
  },
}));

const account: Account = {
  id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  sourceId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  source: "ledger",
  chain: "XMR",
  path: "device",
  address: "4".repeat(95),
  label: "Ledger Nano S",
  scheme: "native",
  methods: ["signMoneroTransfer"],
  verifiedAt: 0,
};

describe("signing setup for directly connected Monero accounts", () => {
  let directory: string;
  let service: CompanionService;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rujira-monero-test-"));
    service = new CompanionService({
      dataDirectory: directory,
      engineDirectory: directory,
      node: "https://node.example",
      extensionId: "a".repeat(32),
    });
    engine.call.mockResolvedValue({ address: account.address });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  function setup(connected = account): CompanionRequest {
    return {
      id: crypto.randomUUID(),
      method: "register",
      account: connected,
      source: "ledger",
      sourceId: connected.sourceId,
      accountIndex: 0,
      restoreHeight: 0,
      password: "test-only-password",
    };
  }
  it("keeps the extension account ID and provisions a wallet only once", async () => {
    expect(await service.request(setup())).toEqual(account);
    expect(await service.request(setup())).toEqual(account);
    expect(engine.provisionHardware).toHaveBeenCalledOnce();
    expect(engine.provisionHardware).toHaveBeenCalledWith(
      account.id,
      "test-only-password",
      "ledger",
      "device",
      0
    );
    const stored: unknown = JSON.parse(
      await readFile(join(directory, "accounts.json"), "utf8")
    );
    expect(stored).toEqual([account]);
  });
  it("rejects another device address before storing the signing wallet", async () => {
    engine.call.mockResolvedValue({ address: "5".repeat(95) });
    await expect(service.request(setup())).rejects.toThrow("does not match");
    await expect(
      readFile(join(directory, "accounts.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects replacing an existing wallet with another address", async () => {
    await service.request(setup());
    await expect(
      service.request(setup({ ...account, address: "5".repeat(95) }))
    ).rejects.toThrow("has changed");
  });
});
