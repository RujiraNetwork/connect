import {
  ApduResponse,
  DeviceActionStatus,
  DeviceManagementKitBuilder,
  DeviceModel,
  DeviceModelId,
} from "@ledgerhq/device-management-kit";
import { DefaultDescriptorTemplate } from "@ledgerhq/device-signer-kit-bitcoin";
import { GetExtendedPublicKeyCommand } from "@ledgerhq/device-signer-kit-bitcoin/internal/app-binder/command/GetExtendedPublicKeyCommand.js";
import { DefaultSignerBtc } from "@ledgerhq/device-signer-kit-bitcoin/internal/DefaultSignerBtc.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import {
  accountPath,
  ERROR_CODES,
  supportedMethods,
  canonicalJson,
} from "@rujira/connect-core";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { NEVER, of, timeout } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toHex } from "./bytes";
import { addressFor } from "./keys";
import { LedgerAdapter } from "./ledger";
import { completeLedgerAction, moneroLedgerError } from "./ledger-actions";
import { verifyResult } from "./verify";

import type { Account, SignRequest } from "@rujira/connect-core";

const account: Account = {
  id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  sourceId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  source: "ledger",
  chain: "BTC",
  path: accountPath("BTC", 0, "ledger"),
  address: "pending",
  label: "Public Bitcoin fixture",
  scheme: "native",
  verifiedAt: 0,
  methods: [...supportedMethods("BTC", "ledger")],
};
const root = HDKey.fromMasterSeed(
  mnemonicToSeedSync(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
  )
);
const bitcoinAccount = root.derive("m/84'/0'/0'");
const bitcoinKey = root.derive(account.path).publicKey;
if (!bitcoinKey) throw new Error("Public fixture has no key");
const bitcoinAddress = addressFor("BTC", bitcoinKey, account.path);

describe("Ledger Bitcoin registration", () => {
  const dmk = new DeviceManagementKitBuilder().build();
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function adapter(displayed = bitcoinAddress): LedgerAdapter {
    vi.spyOn(dmk, "listenToAvailableDevices").mockReturnValue(
      of([
        {
          id: "nano-s-fixture",
          name: "Ledger Nano S",
          deviceModel: new DeviceModel({
            id: "nano-s-fixture",
            model: DeviceModelId.NANO_S,
            name: "Ledger Nano S",
          }),
          transport: "WEB-HID",
        },
      ])
    );
    vi.spyOn(dmk, "connect").mockResolvedValue("fixture-session");
    vi.spyOn(
      DefaultSignerBtc.prototype,
      "getExtendedPublicKey"
    ).mockImplementation((derivationPath) => {
      // Use Ledger's real APDU encoder: it throws for paths containing `m/`.
      const command = new GetExtendedPublicKeyCommand({
        derivationPath,
        checkOnDevice: false,
      });
      expect(Array.from(command.getApdu().getRawApdu())).toEqual([
        0xe1, 0x00, 0x00, 0x01, 0x0e, 0x00, 0x03, 0x80, 0x00, 0x00, 0x54, 0x80,
        0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00,
      ]);
      return {
        observable: of({
          status: DeviceActionStatus.Completed,
          output: { extendedPublicKey: bitcoinAccount.publicExtendedKey },
        }),
        cancel: vi.fn(),
      };
    });
    vi.spyOn(DefaultSignerBtc.prototype, "getWalletAddress").mockImplementation(
      (wallet, index, options) => {
        expect(wallet).toEqual({
          derivationPath: "84'/0'/0'",
          template: DefaultDescriptorTemplate.NATIVE_SEGWIT,
        });
        expect(index).toBe(0);
        expect(options).toEqual({ checkOnDevice: true });
        return {
          observable: of({
            status: DeviceActionStatus.Completed,
            output: { address: displayed },
          }),
          cancel: vi.fn(),
        };
      }
    );
    return new LedgerAdapter(dmk);
  }

  it("sends rootless Bitcoin paths while retaining the registered BIP32 path", async () => {
    const registered = await adapter().register(account);
    expect(registered.account.path).toBe("m/84'/0'/0'/0/0");
    expect(registered.account.address).toBe(bitcoinAddress);
    expect(registered.deviceId).toBe("nano-s-fixture");
    expect(registered.deviceName).toBe("Ledger Nano S");
  });

  it("still refuses a displayed address that differs from the derived public key", async () => {
    await expect(
      adapter("bc1-invalid-fixture").register(account)
    ).rejects.toMatchObject({ code: ERROR_CODES.invalid });
  });
  it("rejects an out-of-range Bitcoin account before opening a device session", async () => {
    const ledger = adapter();
    const connect = vi.spyOn(dmk, "connect");
    await expect(
      ledger.register({ ...account, path: "m/84'/0'/101'/0/0" })
    ).rejects.toMatchObject({ code: ERROR_CODES.invalid });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("Ledger Cosmos protocol", () => {
  const key = root.derive("m/44'/118'/0'/0/0");
  if (!key.publicKey || !key.privateKey)
    throw new Error("Missing Cosmos fixture key");
  const publicKey = key.publicKey;
  const privateKey = key.privateKey;
  const cosmosAccount: Account = {
    ...account,
    chain: "GAIA",
    path: "m/44'/118'/0'/0/0",
    address: addressFor("GAIA", publicKey, "m/44'/118'/0'/0/0"),
    publicKey: toHex(publicKey),
    methods: ["signAmino"],
  };
  const dmk = new DeviceManagementKitBuilder().build();
  const pathBytes = [
    0x2c, 0, 0, 0x80, 0x76, 0, 0, 0x80, 0, 0, 0, 0x80, 0, 0, 0, 0, 0, 0, 0, 0,
  ];
  afterEach(() => {
    vi.restoreAllMocks();
  });
  function cosmosAdapter(): LedgerAdapter {
    vi.spyOn(dmk, "listenToAvailableDevices").mockReturnValue(
      of([
        {
          id: "new-connection-id",
          name: "Ledger Nano S",
          deviceModel: new DeviceModel({
            id: "fixture",
            name: "Ledger Nano S",
            model: DeviceModelId.NANO_S,
          }),
          transport: "WEB-HID",
        },
      ])
    );
    vi.spyOn(dmk, "connect").mockResolvedValue("cosmos-session");
    vi.spyOn(dmk, "executeDeviceAction").mockReturnValue({
      observable: of({
        status: DeviceActionStatus.Completed,
        output: undefined,
      }),
      cancel: vi.fn(),
    });
    return new LedgerAdapter(dmk);
  }
  function addressResponse(): ApduResponse {
    return new ApduResponse({
      data: new Uint8Array([
        ...publicKey,
        ...new TextEncoder().encode(cosmosAccount.address),
      ]),
      statusCode: new Uint8Array([0x90, 0]),
    });
  }
  it("uses the Cosmos HRP and little-endian path, including after a browser connection ID changes", async () => {
    const ledger = cosmosAdapter();
    const send = vi
      .spyOn(dmk, "sendApdu")
      .mockImplementation(({ apdu, abortTimeout }) => {
        expect([...apdu]).toEqual([
          0x55,
          4,
          1,
          0,
          27,
          6,
          ...new TextEncoder().encode("cosmos"),
          ...pathBytes,
        ]);
        expect(abortTimeout).toBe(290_000);
        return Promise.resolve(addressResponse());
      });
    const registered = await ledger.register(
      cosmosAccount,
      "old-connection-id"
    );
    expect(registered.account).toEqual(cosmosAccount);
    expect(registered.deviceId).toBe("new-connection-id");
    expect(send).toHaveBeenCalledOnce();
  });
  it("recognises a saved wallet by re-reading its key before confirming the new address", async () => {
    const ledger = cosmosAdapter();
    const display: number[] = [];
    vi.spyOn(dmk, "sendApdu").mockImplementation(({ apdu }) => {
      display.push(apdu[2] ?? -1);
      return Promise.resolve(addressResponse());
    });
    const registered = await ledger.register(
      { ...cosmosAccount, sourceId: crypto.randomUUID() },
      undefined,
      [cosmosAccount]
    );
    expect(registered.matchedSourceId).toBe(cosmosAccount.sourceId);
    expect(display).toEqual([0, 1]);
  });
  it("signs canonical Amino through the real Cosmos encoder and verifies its returned signature", async () => {
    const ledger = cosmosAdapter();
    const request: SignRequest = {
      chain: "GAIA",
      accountId: cosmosAccount.id,
      method: "signAmino",
      params: {
        chain_id: "cosmoshub-4",
        account_number: "0",
        sequence: "0",
        fee: { amount: [{ denom: "uatom", amount: "1000" }], gas: "200000" },
        msgs: [
          {
            type: "cosmos-sdk/MsgSend",
            value: {
              from_address: cosmosAccount.address,
              to_address: cosmosAccount.address,
              amount: [{ denom: "uatom", amount: "1" }],
            },
          },
        ],
        memo: "",
      },
    };
    const message = canonicalJson(request.params);
    const signature = secp256k1
      .sign(sha256(new TextEncoder().encode(message)), privateKey)
      .toBytes("der");
    vi.spyOn(dmk, "sendApdu").mockImplementation(({ apdu }) => {
      if (apdu[1] === 4) return Promise.resolve(addressResponse());
      expect(apdu[1]).toBe(2);
      if (apdu[2] === 0) expect([...apdu.slice(5)]).toEqual(pathBytes);
      return Promise.resolve(
        new ApduResponse({
          data: apdu[2] === 2 ? signature : new Uint8Array(),
          statusCode: new Uint8Array([0x90, 0]),
        })
      );
    });
    const connect = vi.spyOn(dmk, "connect");
    const signed = await ledger.sign(
      cosmosAccount,
      request,
      "old-connection-id"
    );
    expect(connect).toHaveBeenCalledOnce();
    expect(() => {
      verifyResult(cosmosAccount, request, signed);
    }).not.toThrow();
  });
  it("turns legacy Cosmos status codes into useful errors instead of the generic signing failure", async () => {
    const ledger = cosmosAdapter();
    vi.spyOn(dmk, "sendApdu").mockResolvedValue(
      new ApduResponse({
        data: new Uint8Array(),
        statusCode: new Uint8Array([0x55, 0x15]),
      })
    );
    const registration = ledger.register(cosmosAccount);
    await expect(registration).rejects.toMatchObject({
      code: ERROR_CODES.locked,
    });
    await expect(registration).rejects.toThrow("Unlock");
  });
});

describe("Ledger action errors", () => {
  it.each([
    [0x6910, ERROR_CODES.locked, "Unlock"],
    [0x69ee, ERROR_CODES.locked, "Unlock"],
    [0x6982, ERROR_CODES.rejected, "declined"],
    [0x6983, ERROR_CODES.invalid, "wallet keys"],
    [0x6a30, ERROR_CODES.unsupported, "client version"],
    [0x6a31, ERROR_CODES.unsupported, "client version"],
  ])("explains Monero app status 0x%s", (status, code, message) => {
    const error = moneroLedgerError(status);
    expect(error.code).toBe(code);
    expect(error.message).toContain(message);
  });
  function failed(error: unknown) {
    return {
      observable: of({ status: DeviceActionStatus.Error as const, error }),
      cancel: vi.fn(),
    };
  }

  it.each([
    [{ _tag: "DeviceLockedError" }, ERROR_CODES.locked, "Unlock"],
    [
      { _tag: "GlobalCommandError", errorCode: "5515" },
      ERROR_CODES.locked,
      "Unlock",
    ],
    [
      { _tag: "BtcAppCommandError", errorCode: "6985" },
      ERROR_CODES.rejected,
      "declined",
    ],
    [
      { _tag: "GlobalCommandError", errorCode: "6e00" },
      ERROR_CODES.unsupported,
      "0x6e00",
    ],
    [{ _tag: "DeviceBusyError" }, ERROR_CODES.busy, "busy"],
    [{ _tag: "SendApduTimeoutError" }, ERROR_CODES.disconnected, "in time"],
  ])(
    "classifies device error %j without labelling every failure a cancellation",
    async (error, code, message) => {
      const action = failed(error);
      const result = completeLedgerAction(action);
      await expect(result).rejects.toMatchObject({ code });
      await expect(result).rejects.toThrow(message);
      expect(action.cancel).toHaveBeenCalledOnce();
    }
  );

  it("keeps vendor payloads and nested messages out of the returned error", async () => {
    await expect(
      completeLedgerAction(
        failed({
          _tag: "UnknownDeviceExchangeError",
          message: "private-payload",
          originalError: { message: "private-payload" },
        })
      )
    ).rejects.toMatchObject({
      code: ERROR_CODES.internal,
      message:
        "Ledger request failed (UnknownDeviceExchangeError). Unlock the device, open the selected network's app, and try again.",
    });
  });

  it("handles observable timeouts separately from a stopped request", async () => {
    await expect(
      completeLedgerAction({
        observable: NEVER.pipe(timeout(1)),
        cancel: vi.fn(),
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.disconnected });
    const stopped = completeLedgerAction({
      observable: of({ status: DeviceActionStatus.Stopped }),
      cancel: vi.fn(),
    });
    await expect(stopped).rejects.toMatchObject({ code: ERROR_CODES.rejected });
    await expect(stopped).rejects.toThrow("cancelled");
  });
});
