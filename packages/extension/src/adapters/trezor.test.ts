import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction as EthereumTransaction } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fromHex } from "./bytes";
import { nativeMoneroFixture } from "./fixtures/monero-native";
import deviceFixture from "./fixtures/trezor-monero-device.json";
import { moneroKeys, moneroPublicKeys } from "./monero-keys";
import { assembleMoneroTransaction } from "./monero-transactions";
import { registerSoftware, signSoftware } from "./software";
import { TrezorAdapter } from "./trezor";
import { verifyResult } from "./verify";

import type { Account } from "@rujira/connect-core";
import type { Device, UiRequestMessage } from "@trezor/connect-core";

const sdk = vi.hoisted(() => ({
  init: vi.fn(() => Promise.resolve()),
  on: vi.fn<
    (event: string, listener: (request: UiRequestMessage) => void) => void
  >(),
  dispose: vi.fn(),
  cancel: vi.fn(),
  uiResponse: vi.fn(),
  ethereumGetAddress: vi.fn(),
  ethereumGetPublicKey: vi.fn(),
  ethereumSignTransaction: vi.fn(),
  getFeatures: vi.fn(),
  moneroGetAddress: vi.fn(),
  moneroSignTransaction: vi.fn(),
}));
vi.mock("@trezor/connect-core", () => ({
  default: sdk,
  PROTO: { MoneroNetworkType: { MAINNET: 0 } },
  UI_REQUEST: "UI_REQUEST",
  UI_REQUESTS: {
    REQUEST_PIN: "ui-request_pin",
    REQUEST_PASSPHRASE: "ui-request_passphrase",
    REQUEST_THP_PAIRING_TAG: "ui-request_thp_pairing_tag",
    REQUEST_CONFIRMATION: "ui-request_confirmation",
    REQUEST_ACCOUNT: "ui-request_account",
    REQUEST_FEE: "ui-request_fee",
    REQUEST_WORD: "ui-request_word",
    REQUEST_DISCOVERY_ACCOUNTS: "ui-request_discovery_accounts",
  },
  UI_RESPONSE: {
    RECEIVE_PIN: "ui-receive_pin",
    RECEIVE_PASSPHRASE: "ui-receive_passphrase",
    RECEIVE_THP_PAIRING_TAG: "ui-receive_thp_pairing_tag",
    RECEIVE_CONFIRMATION: "ui-receive_confirmation",
  },
}));

const account: Account = registerSoftware(
  mnemonicToSeedSync(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
  ),
  {
    id: crypto.randomUUID(),
    sourceId: crypto.randomUUID(),
    source: "trezor",
    chain: "ETH",
    label: "Trezor",
    path: "m/44'/60'/0'/0/0",
    scheme: "native",
    methods: ["personal_sign"],
    verifiedAt: 0,
  }
);
const device: Device = {
  type: "unacquired",
  path: "test-device" as Device["path"],
  name: "Trezor",
  label: "Unacquired device",
  descriptor: { apiType: "usb", id: "test-device" },
};

describe("local Trezor connection", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      usb: { getDevices: () => Promise.resolve([]) },
    });
    sdk.ethereumGetAddress.mockResolvedValue({
      success: true,
      payload: { address: account.address },
    });
    sdk.ethereumGetPublicKey.mockResolvedValue({
      success: true,
      payload: { publicKey: account.publicKey },
    });
    sdk.getFeatures.mockResolvedValue({
      success: true,
      payload: {
        device_id: "trezor-fixture",
        internal_model: "T3B1",
        model: "R",
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("signs dapp-prepared Monero data directly and returns native bytes without a password or node", async () => {
    const keys = moneroKeys(
      mnemonicToSeedSync(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
      ),
      "m/44'/128'/0'"
    );
    const fixture = nativeMoneroFixture(
      fromHex(keys.spendKey),
      fromHex(keys.viewKey),
      "trezor"
    );
    const expected = assembleMoneroTransaction(
      fixture.account,
      fixture.prepared,
      deviceFixture
    );
    sdk.moneroGetAddress.mockResolvedValue({
      success: true,
      payload: { address: fixture.account.address },
    });
    sdk.moneroSignTransaction.mockResolvedValue({
      success: true,
      payload: deviceFixture,
    });
    const signed = await new TrezorAdapter().sign(fixture.account, {
      accountId: fixture.account.id,
      chain: "XMR",
      method: "signMoneroTransaction",
      params: fixture.prepared,
    });
    expect(signed).toMatchObject({
      transactionHex: expected.transactionHex,
      transactionHash: expected.transactionHash,
    });
    expect(sdk.moneroSignTransaction).toHaveBeenCalledWith({
      path: fixture.account.path,
      networkType: 0,
      inputs: fixture.prepared.inputs,
      tsx_data: {
        ...fixture.prepared.tsx_data,
        outputs: fixture.prepared.tsx_data.outputs.map((output) => ({
          ...output,
          original: Buffer.from(output.original).toString("hex"),
        })),
        change_dts: {
          ...fixture.prepared.tsx_data.change_dts,
          original: Buffer.from(
            fixture.prepared.tsx_data.change_dts.original
          ).toString("hex"),
        },
      },
    });
    sdk.moneroSignTransaction.mockClear();
    const altered = structuredClone(fixture.prepared);
    altered.tsx_data.fee++;
    await expect(
      new TrezorAdapter().sign(fixture.account, {
        accountId: fixture.account.id,
        chain: "XMR",
        method: "signMoneroTransaction",
        params: altered,
      })
    ).rejects.toThrow("cover the outputs");
    expect(sdk.moneroSignTransaction).not.toHaveBeenCalled();
  });
  it.each([0, 2] as const)(
    "accepts the SDK's prefixed native signature for transaction type %s",
    async (type) => {
      const seed = mnemonicToSeedSync(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
      );
      const signingAccount = {
        ...account,
        methods: ["eth_signTransaction" as const],
      };
      const request = {
        accountId: account.id,
        chain: "ETH" as const,
        method: "eth_signTransaction" as const,
        params: {
          chainId: "1",
          nonce: 0,
          gasLimit: "21000",
          to: account.address,
          value: "1",
          type,
          ...(type === 2
            ? { maxFeePerGas: "2", maxPriorityFeePerGas: "1" }
            : { gasPrice: "1" }),
        },
      };
      const signed = EthereumTransaction.from(
        signSoftware(seed, signingAccount, request) as string
      );
      if (!signed.signature) throw new Error("Missing fixture signature");
      sdk.ethereumSignTransaction.mockResolvedValue({
        success: true,
        payload: {
          r: signed.signature.r,
          s: signed.signature.s,
          v: `0x${(signed.signature.networkV ?? BigInt(signed.signature.v)).toString(16)}`,
        },
      });
      verifyResult(
        signingAccount,
        request,
        await new TrezorAdapter().sign(signingAccount, request)
      );
    }
  );
  it("uses a direct USB transport and checks the device's displayed address", async () => {
    expect(await new TrezorAdapter().register(account)).toEqual(account);
    expect(await new TrezorAdapter().deviceInfo()).toEqual({
      deviceId: "trezor-fixture",
      deviceName: "Trezor Safe 3",
    });
    expect(sdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        transports: [
          expect.objectContaining({ name: "WebUsbTransport", apiType: "usb" }),
        ],
      })
    );
    sdk.ethereumGetAddress.mockResolvedValueOnce({
      success: true,
      payload: { address: "0x0000000000000000000000000000000000000000" },
    });
    await expect(new TrezorAdapter().register(account)).rejects.toThrow(
      "does not match"
    );
  });
  it("binds PIN and passphrase answers to the active prompt without saving secrets", async () => {
    const adapter = new TrezorAdapter();
    await adapter.register(account);
    const receive = sdk.on.mock.calls[0]?.[1];
    if (!receive) throw new Error("No local device prompt listener");
    receive({
      event: "UI_REQUEST",
      type: "ui-request_pin",
      requestId: "pin-1",
      payload: { device },
    });
    expect(adapter.prompt?.kind).toBe("pin");
    expect(() => {
      adapter.respond({
        action: "deviceResponse",
        id: "stale",
        value: "123",
        cancel: false,
        onDevice: false,
      });
    }).toThrow("expired");
    expect(sdk.uiResponse).not.toHaveBeenCalled();
    expect(() => {
      adapter.respond({
        action: "deviceResponse",
        id: "pin-1",
        value: "0",
        cancel: false,
        onDevice: false,
      });
    }).toThrow("positions");
    adapter.respond({
      action: "deviceResponse",
      id: "pin-1",
      value: "789",
      cancel: false,
      onDevice: false,
    });
    expect(sdk.uiResponse).toHaveBeenLastCalledWith({
      requestId: "pin-1",
      type: "ui-receive_pin",
      payload: "789",
    });
    expect(adapter.prompt).toBeUndefined();
    receive({
      event: "UI_REQUEST",
      type: "ui-request_passphrase",
      requestId: "passphrase-1",
      payload: { device },
    });
    adapter.respond({
      action: "deviceResponse",
      id: "passphrase-1",
      value: "",
      cancel: false,
      onDevice: true,
    });
    expect(sdk.uiResponse).toHaveBeenLastCalledWith({
      requestId: "passphrase-1",
      type: "ui-receive_passphrase",
      payload: { value: "", passphraseOnDevice: true, save: false },
    });
    adapter.disconnect();
    expect(sdk.dispose).toHaveBeenCalled();
  });
  it("reads and confirms a Monero address directly without exporting private view keys", async () => {
    const path = "m/44'/128'/2'";
    const address = moneroKeys(
      mnemonicToSeedSync(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
      ),
      path
    ).address;
    sdk.moneroGetAddress.mockResolvedValue({
      success: true,
      payload: { address },
    });
    const registered = await new TrezorAdapter().register({
      ...account,
      chain: "XMR",
      path,
      methods: ["signMoneroTransaction"],
    });
    expect(registered.address).toBe(address);
    expect(registered.publicKey).toBe(moneroPublicKeys(address).publicKey);
    expect(sdk.moneroGetAddress).toHaveBeenCalledWith({
      path,
      showOnTrezor: true,
    });
  });
});
