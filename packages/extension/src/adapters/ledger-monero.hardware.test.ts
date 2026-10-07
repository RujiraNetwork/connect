import { Buffer } from "buffer";
import { readFile, writeFile } from "node:fs/promises";

import {
  RecordStore,
  openTransportReplayer,
} from "@ledgerhq/hw-transport-mocker";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { fromHex, toHex } from "./bytes";
import { nativeMoneroFixture } from "./fixtures/monero-native";
import { moneroLedgerError } from "./ledger-actions";
import { signLedgerMonero } from "./ledger-monero";
import { hashScalar } from "./monero-crypto";
import { verifyMoneroTransaction } from "./monero-transactions";

import type { MoneroExchange } from "./ledger-monero";

const endpoint = process.env.RUJIRA_SPECULOS_URL;
const directory = new URL("./fixtures/", import.meta.url);
const root = HDKey.fromMasterSeed(
  mnemonicToSeedSync(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
  )
);
const privateKey = root.derive("m/44'/128'/0'/0/0").privateKey;
if (!privateKey) throw new Error("Missing public Ledger fixture seed");
const spend = hashScalar(privateKey);
const view = hashScalar(spend);
const apduResult = z.object({ data: z.string() });
const eventsResult = z.object({
  events: z.array(z.object({ text: z.string() })),
});

function entropy(): void {
  let counter = 0;
  vi.spyOn(crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView>(bytes: T): T => {
      if (!(bytes instanceof Uint8Array))
        throw new Error("Unexpected fixture entropy");
      for (let index = 0; index < bytes.length; index++)
        bytes[index] = (counter++ * 73 + 19) & 255;
      return bytes;
    }
  );
}
async function emulatorExchange(
  store: RecordStore,
  apdu: Uint8Array,
  timeout = 10_000
): Promise<Uint8Array> {
  if (!endpoint) throw new Error("Missing Speculos endpoint");
  const responsePromise = fetch(`${endpoint}/apdu`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: toHex(apdu) }),
    signal: AbortSignal.timeout(20_000),
  }).then(async (response) => apduResult.parse(await response.json()));
  const state = { completed: false };
  const response = responsePromise.then(
    (data) => {
      state.completed = true;
      return { success: true as const, data };
    },
    (error: unknown) => {
      state.completed = true;
      return { success: false as const, error };
    }
  );
  if (timeout > 10_000) {
    while (!(await Promise.resolve(state.completed))) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      if (await Promise.resolve(state.completed)) break;
      const events = eventsResult.parse(
        await (
          await fetch(`${endpoint}/events?stream=false&currentscreenonly=true`)
        ).json()
      );
      const text = events.events.map((event) => event.text).join(" ");
      const button =
        /\b(?:Ok|Accept|Approve|Confirm|Yes|Sign transaction)\b/i.test(text)
          ? "both"
          : "right";
      await fetch(`${endpoint}/button/${button}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "press-and-release" }),
      });
    }
  }
  const result = await response;
  if (!result.success) throw result.error;
  const data = fromHex(result.data.data);
  store.recordExchange(Buffer.from(apdu), Buffer.from(data));
  const status = (data.at(-2) ?? 0) * 256 + (data.at(-1) ?? 0);
  if (status !== 0x9000) throw moneroLedgerError(status);
  return data.slice(0, -2);
}

describe("Ledger's published emulator and mock transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each([
    { name: "0", real: 0, multiple: false },
    { name: "2", real: 2, multiple: false },
    { name: "15", real: 15, multiple: false },
    { name: "multiple", real: 2, multiple: true },
  ])(
    "registers and signs Monero on Nano S with ring case $name",
    async ({ name, real, multiple }) => {
      entropy();
      const fixture = nativeMoneroFixture(spend, view, "ledger", real);
      if (multiple) {
        const second = nativeMoneroFixture(
          spend,
          view,
          "ledger",
          15,
          7,
          91
        ).prepared;
        const input = second.inputs[0];
        if (!input) throw new Error("Missing second fixture input");
        input.real_out_additional_tx_keys = [input.real_out_tx_key];
        input.real_out_tx_key =
          fixture.prepared.inputs[0]?.real_out_tx_key ?? "";
        const pairs = [...fixture.prepared.inputs, input]
          .map((entry, index) => ({
            input: entry,
            image:
              [...fixture.prepared.keyImages, ...second.keyImages][index] ?? "",
          }))
          .toSorted((left, right) => right.image.localeCompare(left.image));
        fixture.prepared.inputs = pairs.map((pair) => pair.input);
        fixture.prepared.keyImages = pairs.map((pair) => pair.image);
        fixture.prepared.tsx_data.num_inputs = 2;
        fixture.prepared.tsx_data.minor_indices = [0, 7];
        const destination = fixture.prepared.tsx_data.outputs[0];
        if (!destination) throw new Error("No recipient");
        destination.amount = 300;
      }
      const file = new URL(`ledger-monero-nanos-${name}.apdu`, directory);
      const store = endpoint
        ? new RecordStore()
        : RecordStore.fromString(await readFile(file, "utf8"));
      const transport = await openTransportReplayer(store);
      const exchange: MoneroExchange = endpoint
        ? (apdu, timeout) => emulatorExchange(store, apdu, timeout)
        : async (apdu) => {
            const data = await transport.exchange(Buffer.from(apdu));
            const status = data.readUInt16BE(data.length - 2);
            if (status !== 0x9000) throw moneroLedgerError(status);
            return new Uint8Array(data.subarray(0, -2));
          };
      const version = new TextEncoder().encode("0.18.4.6");
      await exchange(
        new Uint8Array([4, 2, 0, 0, version.length + 1, 0, ...version])
      );
      const registered = await exchange(new Uint8Array([4, 0x20, 1, 0, 1, 0]));
      expect(new TextDecoder().decode(registered.slice(64))).toBe(
        fixture.account.address
      );
      await exchange(
        new Uint8Array([4, 0x21, 0, 0, 17, ...new Uint8Array(17)]),
        290_000
      );
      const signed = await signLedgerMonero(
        fixture.account,
        fixture.prepared,
        exchange
      );
      verifyMoneroTransaction(fixture.account, fixture.prepared, signed);
      expect(signed.amount).toBe(multiple ? "300" : "100");
      if (endpoint && process.env.RUJIRA_RECORD_HARDWARE === "1")
        await writeFile(file, store.toString());
      if (!endpoint) store.ensureQueueEmpty();
    },
    60_000
  );
});

describe("Ledger Monero failures through the published mock transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each([
    { name: "user rejection", ins: 0x7c, p1: 1, response: "6982" },
    {
      name: "incomplete transaction handle",
      ins: 0x70,
      p1: 1,
      response: "009000",
    },
    {
      name: "different owned key image",
      ins: 0x3a,
      p1: 0,
      response: "00".repeat(32) + "9000",
    },
    {
      name: "different prefix hash",
      ins: 0x7d,
      p1: 2,
      response: "00".repeat(32) + "9000",
    },
    {
      name: "different signing hash",
      ins: 0x7c,
      p1: 3,
      response: "00".repeat(32) + "9000",
      final: true,
    },
    {
      name: "forged CLSAG response",
      ins: 0x7f,
      p1: 3,
      response: "00".repeat(32) + "9000",
    },
  ])(
    "rejects $name and closes the transaction",
    async ({ ins, p1, response, final }) => {
      entropy();
      const fixture = nativeMoneroFixture(spend, view, "ledger");
      const original = RecordStore.fromString(
        await readFile(new URL("ledger-monero-nanos-2.apdu", directory), "utf8")
      );
      const queue = original.queue.slice(3);
      const index = queue.findIndex(([command]) => {
        const apdu = Buffer.from(command, "hex");
        return apdu[1] === ins && apdu[2] === p1 && (!final || apdu[5] === 0);
      });
      const chosen = queue[index];
      const close = queue.at(-1);
      if (!chosen || !close) throw new Error("No recorded failure boundary");
      const store = new RecordStore([
        ...queue.slice(0, index),
        [chosen[0], response],
        close,
      ]);
      const transport = await openTransportReplayer(store);
      const buffers: Uint8Array[] = [];
      await expect(
        signLedgerMonero(fixture.account, fixture.prepared, async (apdu) => {
          const result = await transport.exchange(Buffer.from(apdu));
          const status = result.readUInt16BE(result.length - 2);
          if (status !== 0x9000) throw moneroLedgerError(status);
          const bytes = new Uint8Array(result.subarray(0, -2));
          buffers.push(bytes);
          return bytes;
        })
      ).rejects.toThrow();
      store.ensureQueueEmpty();
      // The original 224-byte OPEN_TX response contains all session handles.
      for (const bytes of buffers.filter((buffer) => buffer.length === 224))
        expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
  );
  it.each(["disconnect", "timeout"])(
    "preserves the %s error when cleanup cannot reach the device",
    async (reason) => {
      entropy();
      const fixture = nativeMoneroFixture(spend, view, "ledger");
      const original = RecordStore.fromString(
        await readFile(new URL("ledger-monero-nanos-2.apdu", directory), "utf8")
      );
      const store = new RecordStore(original.queue.slice(3, 5));
      const transport = await openTransportReplayer(store);
      const calls: number[] = [];
      await expect(
        signLedgerMonero(fixture.account, fixture.prepared, async (apdu) => {
          calls.push(apdu[1] ?? 0);
          if (store.isEmpty())
            throw new Error(apdu[1] === 0x80 ? "cleanup unavailable" : reason);
          const result = await transport.exchange(Buffer.from(apdu));
          return new Uint8Array(result.subarray(0, -2));
        })
      ).rejects.toThrow(reason);
      expect(calls.at(-1)).toBe(0x80);
      store.ensureQueueEmpty();
    }
  );
});
