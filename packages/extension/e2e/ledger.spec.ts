import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test } from "@playwright/test";
import {
  accountPath,
  EMPTY_STATE,
  ERROR_CODES,
  supportedMethods,
} from "@rujira/connect-core";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

import { configureLedgerFixture, installLedgerFixture } from "./ledger-fixture";
import { addressFor } from "../src/adapters/keys";
import { moneroKeys, moneroPublicKeys } from "../src/adapters/monero-keys";

test("registers Cosmos and Monero through bundled WebHID and groups one Nano S in Settings", async () => {
  const profile = await mkdtemp(join(tmpdir(), "rujira-ledger-fixture-"));
  const path = resolve("packages/extension/dist");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const seed = mnemonicToSeedSync(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    );
    const root = HDKey.fromMasterSeed(seed);
    const cosmos = [0, 1].map((index) => {
      const derivation = accountPath("GAIA", index, "ledger");
      const key = root.derive(derivation).publicKey;
      if (!key) throw new Error("Missing public test key");
      return {
        publicKey: [...key],
        address: addressFor("GAIA", key, derivation),
      };
    });
    const moneroAddress = moneroKeys(
      seed,
      accountPath("XMR", 0, "keystore")
    ).address;
    const moneroPublic = moneroPublicKeys(moneroAddress);
    const moneroFixture = {
      address: moneroAddress,
      publicKey: [...moneroPublic.publicSpend, ...moneroPublic.publicView],
    };
    await installLedgerFixture(worker, cosmos, moneroFixture, {
      initialApp: "Monero",
      ignoreMoneroReset: true,
    });
    const sourceId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    await worker.evaluate(
      async ({ state, sourceId }) => {
        await chrome.storage.local.set({
          state: {
            ...state,
            sources: [
              {
                id: sourceId,
                kind: "ledger",
                label: "Ledger",
                deviceId: "previous-session",
              },
              {
                id: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
                kind: "ledger",
                label: "Ledger",
                deviceId: "previous-session",
              },
            ],
          },
        });
      },
      { state: EMPTY_STATE, sourceId }
    );
    const id = new URL(worker.url()).hostname;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${id}/index.html`);
    const add = async (
      chain: "GAIA" | "XMR",
      accountIndex: number
    ): Promise<unknown> =>
      manager.evaluate(
        async ({ chain, accountIndex, sourceId }): Promise<unknown> =>
          chrome.runtime.sendMessage({
            action: "register",
            source: "ledger",
            sourceId,
            chain,
            accountIndex,
            profile: "default",
          }),
        { chain, accountIndex, sourceId }
      );
    const stalled = await add("XMR", 0);
    expect(stalled).toMatchObject({
      ok: false,
      error: {
        code: ERROR_CODES.disconnected,
        message: expect.stringContaining("starting the Monero connection"),
      },
    });
    await configureLedgerFixture(worker, "Monero");
    const moneroResult = await add("XMR", 0);
    expect(moneroResult, JSON.stringify(moneroResult)).toMatchObject({
      ok: true,
      result: { address: moneroAddress, path: "device" },
    });
    const repeated: unknown = await manager.evaluate(
      async (): Promise<unknown> =>
        chrome.runtime.sendMessage({
          action: "register",
          source: "ledger",
          chain: "XMR",
          accountIndex: 0,
          profile: "default",
        })
    );
    expect(repeated).toMatchObject({
      ok: true,
      result: { sourceId, address: moneroAddress },
    });
    await manager.evaluate(async (): Promise<unknown> =>
      chrome.runtime.sendMessage({ action: "lock" })
    );
    await configureLedgerFixture(worker, "Cosmos");
    expect(await add("GAIA", 0)).toMatchObject({
      ok: true,
      result: { address: cosmos[0]?.address },
    });
    expect(await add("GAIA", 1)).toMatchObject({
      ok: true,
      result: { address: cosmos[1]?.address },
    });
    await manager.reload();
    await expect(manager.locator("article.account")).toHaveCount(3);
    await expect(manager.locator("article.account strong")).toHaveText([
      "Ledger Nano S",
      "Ledger Nano S",
      "Ledger Nano S · m/44'/118'/1'/0/0",
    ]);
    await manager.screenshot({
      path: "test-results/rujira-connect-ledger-accounts.png",
      fullPage: true,
    });
    await expect(manager.locator('[data-network="GAIA"]')).toHaveCount(2);
    await expect(
      manager.getByText("m/44'/118'/1'/0/0", { exact: true })
    ).toBeVisible();
    await expect(
      manager.locator(
        '.account-address button[aria-label="Copy Monero address"] svg'
      )
    ).toBeVisible();
    await expect(manager.locator(".account-actions svg")).toHaveCount(3);
    await manager
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await expect(manager.locator("article.source")).toHaveCount(1);
    await expect(manager.locator("article.source strong")).toHaveText(
      "Ledger Nano S · bbbbbbbb"
    );
    await expect(
      manager.getByRole("heading", { name: "Monero signing", exact: true })
    ).toBeVisible();
    await manager.screenshot({
      path: "test-results/rujira-connect-settings.png",
      fullPage: true,
    });
    await manager
      .getByRole("button", { name: "Accounts", exact: true })
      .click();
    await manager
      .getByRole("button", { name: "+ Add another account", exact: true })
      .click();
    await manager
      .getByRole("combobox", { name: "Network", exact: true })
      .selectOption("XMR");
    await expect(
      manager.getByLabel("Account index", { exact: true })
    ).toHaveCount(0);
    await expect(
      manager.getByLabel("Local Monero wallet password", { exact: true })
    ).toHaveCount(0);
    await expect(
      manager.getByText(
        "Install the Monero companion before adding this account.",
        { exact: true }
      )
    ).toHaveCount(0);
    const saved: unknown = await worker.evaluate(
      async () => (await chrome.storage.local.get("state")).state
    );
    expect(saved).toMatchObject({
      sources: [{ id: sourceId, deviceName: "Ledger Nano S" }],
      accounts: [
        { chain: "XMR" },
        { methods: [...supportedMethods("GAIA", "ledger")] },
        {},
      ],
    });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
