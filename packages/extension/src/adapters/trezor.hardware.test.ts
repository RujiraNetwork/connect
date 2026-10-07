import { writeFile } from "node:fs/promises";

import { signRequestSchema, supportedMethods } from "@rujira/connect-core";
import TrezorConnect, { DEVICE } from "@trezor/connect-core";
import { BridgeTransport } from "@trezor/transport-common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { fromHex } from "./bytes";
import { signingFixtures } from "./fixtures/signing";
import thor from "./fixtures/thor-eip712.json";
import { addressFor } from "./keys";
import { TrezorAdapter } from "./trezor";
import { verifyResult } from "./verify";

const enabled = process.env.RUJIRA_TREZOR_EMULATOR === "1";
const fixtures = enabled
  ? signingFixtures().filter(({ account, request }) =>
      supportedMethods(account.chain, "trezor").includes(request.method)
    )
  : [];
const responseSchema = z
  .object({
    id: z.number(),
    success: z.boolean(),
    error: z.string().optional(),
  })
  .passthrough();
async function control(
  type: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket("ws://127.0.0.1:9001");
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Trezor controller timed out: ${type}`));
    }, 30_000);
    socket.onopen = () => {
      socket.send(JSON.stringify({ id: 1, type, ...params }));
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      const parsed = responseSchema.safeParse(JSON.parse(event.data));
      if (!parsed.success) return;
      clearTimeout(timer);
      socket.close();
      if (parsed.data.success) resolve();
      else
        reject(
          new Error(parsed.data.error ?? `Trezor controller failed: ${type}`)
        );
    };
    socket.onerror = () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("Trezor emulator is unavailable"));
    };
  });
}

describe.runIf(enabled)("Trezor published firmware emulator", () => {
  const adapter = new TrezorAdapter(
    () => new BridgeTransport({ id: "rujira-firmware-tests", port: 21328 })
  );
  let confirmations = Promise.resolve();
  let confirmationError: unknown;
  let prompts: ReturnType<typeof setInterval> | undefined;
  const recorded: {
    account: (typeof fixtures)[number]["account"];
    request: (typeof fixtures)[number]["request"];
    signed: unknown;
  }[] = [];
  beforeAll(async () => {
    const moneroSign = TrezorConnect.moneroSignTransaction;
    TrezorConnect.moneroSignTransaction = async (params) => {
      const response = await moneroSign(params);
      if (response.success && process.env.RUJIRA_RECORD_HARDWARE === "1")
        await writeFile(
          new URL("./fixtures/trezor-monero-device.json", import.meta.url),
          JSON.stringify(response.payload, null, 2) + "\n"
        );
      return response;
    };
    TrezorConnect.on(DEVICE.BUTTON, () => {
      confirmations = confirmations.then(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
        await control("emulator-press-yes");
      });
      confirmations.catch((error: unknown) => {
        confirmationError = error;
      });
    });
    await control("bridge-stop");
    await control("emulator-start", {
      model: "T2T1",
      version: process.env.RUJIRA_TREZOR_FIRMWARE ?? "2.12.5-arm",
      wipe: true,
    });
    await control("emulator-setup", {
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      pin: "",
      passphrase_protection: false,
      label: "Public Rujira fixture",
    });
    await control("bridge-start", { version: "node-bridge" });
    prompts = setInterval(() => {
      const prompt = adapter.prompt;
      if (prompt)
        adapter.respond({
          action: "deviceResponse",
          id: prompt.id,
          value: "",
          cancel: false,
          onDevice: false,
        });
    }, 20);
  }, 90_000);
  afterAll(async () => {
    if (prompts) clearInterval(prompts);
    adapter.disconnect();
    if (
      process.env.RUJIRA_RECORD_HARDWARE === "1" &&
      recorded.length === fixtures.length
    )
      await writeFile(
        new URL("./fixtures/trezor-signing.json", import.meta.url),
        JSON.stringify(recorded, null, 2) + "\n"
      );
  });
  it.each(fixtures)(
    "registers and signs $account.chain / $request.method",
    async ({ account: softwareAccount, request }) => {
      const account = {
        ...softwareAccount,
        source: "trezor" as const,
        methods: [...supportedMethods(softwareAccount.chain, "trezor")],
      };
      try {
        const registered = await adapter.register(account);
        expect(registered.address).toBe(account.address);
        // XRP/TRON expose only the address through Trezor Connect registration.
        const signed = await adapter.sign(registered, request);
        verifyResult(account, request, signed);
        recorded.push({ account, request, signed });
        await confirmations;
        expect(confirmationError).toBeUndefined();
      } finally {
        await confirmations;
      }
    },
    90_000
  );
  it("registers the THORChain Ethereum profile and signs its prepared EIP-712 data", async () => {
    const fixture = fixtures.find((entry) => entry.account.chain === "ETH");
    if (!fixture) throw new Error("Missing public Ethereum fixture");
    const profile = {
      ...fixture.account,
      chain: "THOR" as const,
      source: "trezor" as const,
      scheme: "eip712" as const,
      address: addressFor(
        "THOR",
        fromHex(fixture.account.publicKey ?? ""),
        fixture.account.path,
        "eip712"
      ),
      methods: [...supportedMethods("THOR", "trezor", "eip712")],
    };
    expect((await adapter.register(profile)).address).toBe(profile.address);
    const evm = { ...fixture.account, source: "trezor" as const };
    const request = signRequestSchema.parse({
      accountId: evm.id,
      chain: "ETH",
      method: "eth_signTypedData_v4",
      params: thor.typed,
    });
    verifyResult(evm, request, await adapter.sign(evm, request));
    await confirmations;
  }, 90_000);
});
