import type { Worker } from "@playwright/test";

interface AddressFixture {
  readonly address: string;
  readonly publicKey: number[];
}
interface FixtureOptions {
  readonly initialApp?: string;
  readonly ignoreMoneroReset?: boolean;
}

/** A public-key-only HID fixture using the bundled Ledger SDK and transport. */
export async function installLedgerFixture(
  worker: Worker,
  cosmos: readonly AddressFixture[],
  monero: AddressFixture,
  options: FixtureOptions = {}
): Promise<void> {
  await worker.evaluate(
    ({ cosmos, monero, options }) => {
      let command: number[] = [];
      let expected = 0;
      let app = options.initialApp ?? "Cosmos";
      let ignoreMoneroReset = options.ignoreMoneroReset ?? false;
      const device = {
        vendorId: 0x2c97,
        productId: 0x1011,
        productName: "Nano S",
        opened: false,
        collections: [
          { usagePage: 0xffa0, usage: 1, inputReports: [{ reportId: 0 }] },
        ],
        oninputreport: null as ((event: { data: DataView }) => void) | null,
        open(): Promise<void> {
          this.opened = true;
          return Promise.resolve();
        },
        close(): Promise<void> {
          this.opened = false;
          return Promise.resolve();
        },
        sendReport(_report: number, data: Uint8Array): Promise<void> {
          const sequence = (data[3] ?? 0) * 256 + (data[4] ?? 0);
          if (sequence === 0) {
            command = [];
            expected = (data[5] ?? 0) * 256 + (data[6] ?? 0);
          }
          command.push(
            ...data
              .slice(sequence === 0 ? 7 : 5)
              .slice(0, expected - command.length)
          );
          if (command.length !== expected) return Promise.resolve();
          const encode = (text: string): number[] => [
            ...new TextEncoder().encode(text),
          ];
          let body: number[] = [];
          let status = [0x90, 0];
          const [cla, ins] = command;
          // Simulate a Monero app that cannot answer generic status/ping
          // commands. Address registration must not send them.
          if (app === "Monero" && cla !== 4) return Promise.resolve();
          if (ignoreMoneroReset && cla === 4 && ins === 2)
            return Promise.resolve();
          if (cla === 0xb0 && ins === 1)
            body = [1, app.length, ...encode(app), 5, ...encode("2.1.0")];
          else if (cla === 0xe0 && ins === 0xd8)
            app = new TextDecoder().decode(new Uint8Array(command.slice(5)));
          else if (cla === 0xb0 && ins === 0xa7) app = "BOLOS";
          else if (cla === 0x55 && ins === 4) {
            const indexOffset = 6 + (command[5] ?? 0) + 8;
            const index = (command[indexOffset] ?? 0) & 0x7f;
            const fixture = cosmos[index];
            if (!fixture) throw new Error("Unexpected Cosmos account index");
            body = [...fixture.publicKey, ...encode(fixture.address)];
          } else if (cla === 4 && ins === 2) body = [1, 8, 0];
          else if (cla === 4 && ins === 0x20 && command[2] === 1) {
            body = [
              ...monero.publicKey.slice(32),
              ...monero.publicKey.slice(0, 32),
              ...encode(monero.address),
            ];
          } else if (!(cla === 4 && ins === 0x21)) status = [0x6d, 0];
          const response = [...body, ...status];
          let offset = 0;
          let frameIndex = 0;
          while (offset < response.length) {
            const frame = new Uint8Array(64);
            frame.set([
              data[0] ?? 0,
              data[1] ?? 0,
              5,
              frameIndex >> 8,
              frameIndex & 0xff,
            ]);
            const start = frameIndex === 0 ? 7 : 5;
            if (frameIndex === 0)
              frame.set([response.length >> 8, response.length & 0xff], 5);
            const part = response.slice(offset, offset + 64 - start);
            frame.set(part, start);
            offset += part.length;
            frameIndex++;
            this.oninputreport?.({ data: new DataView(frame.buffer) });
          }
          return Promise.resolve();
        },
      };
      const hid = new EventTarget();
      Object.assign(hid, {
        getDevices: () => Promise.resolve([device]),
        configureFixture: (name: string, ignoreReset: boolean) => {
          app = name;
          ignoreMoneroReset = ignoreReset;
        },
      });
      Object.defineProperty(navigator, "hid", {
        value: hid,
        configurable: true,
      });
    },
    { cosmos, monero, options }
  );
}

/** Change the simulated device's open app without replacing its HID handle. */
export async function configureLedgerFixture(
  worker: Worker,
  app: string,
  ignoreReset = false
): Promise<void> {
  await worker.evaluate(
    ({ app, ignoreReset }) => {
      const fixture = navigator as Navigator & {
        hid: { configureFixture(name: string, ignoreReset: boolean): void };
      };
      fixture.hid.configureFixture(app, ignoreReset);
    },
    { app, ignoreReset }
  );
}
