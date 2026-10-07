import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test } from "@playwright/test";
import { ERROR_CODES } from "@rujira/connect-core";

import { installTrezorFixture } from "./trezor-fixture";

for (const mode of ["universal", "bitcoin-only", "passphrase"] as const)
  test(`connects a paired Safe 3 over USB: ${mode}`, async () => {
    const bitcoinOnly = mode === "bitcoin-only";
    const profile = await mkdtemp(join(tmpdir(), "rujira-trezor-usb-"));
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
      const expected = await installTrezorFixture(
        worker,
        bitcoinOnly,
        mode === "passphrase"
      );
      const id = new URL(worker.url()).hostname;
      const manager = await context.newPage();
      await manager.addInitScript(() => {
        Object.defineProperty(navigator, "usb", {
          configurable: true,
          value: {
            requestDevice: () =>
              Promise.resolve({ productName: "Trezor Safe 3" }),
          },
        });
      });
      await manager.goto(`chrome-extension://${id}/index.html`);
      await manager
        .getByRole("button", { name: "Add an account", exact: true })
        .first()
        .click();
      await manager
        .getByRole("button", { name: "Trezor", exact: true })
        .click();
      await expect(
        manager.getByRole("combobox", { name: "Network", exact: true })
      ).toHaveValue("THOR");
      await manager
        .getByRole("button", { name: "Add account", exact: true })
        .click();
      if (mode === "passphrase") {
        await expect(manager.locator("form .device-prompt")).toBeVisible();
        await expect(manager.locator("main > .device-prompt")).toHaveCount(0);
        await expect(manager.getByLabel("Wallet passphrase")).toBeVisible();
        await expect(
          manager.getByRole("button", { name: "Use this wallet", exact: true })
        ).toBeEnabled();
        await expect(
          manager.getByRole("combobox", { name: "Network", exact: true })
        ).toBeDisabled();
        const passphraseField = await manager
          .getByLabel("Wallet passphrase")
          .boundingBox();
        const submitButton = await manager
          .getByRole("button", { name: "Use this wallet", exact: true })
          .boundingBox();
        const cancelButton = await manager
          .getByRole("button", { name: "Cancel", exact: true })
          .boundingBox();
        expect(passphraseField).not.toBeNull();
        expect(submitButton).not.toBeNull();
        expect(cancelButton).not.toBeNull();
        if (passphraseField && submitButton && cancelButton) {
          expect(submitButton.y).toBeGreaterThanOrEqual(
            passphraseField.y + passphraseField.height
          );
          expect(cancelButton.y).toBeGreaterThanOrEqual(
            submitButton.y + submitButton.height
          );
        }
        await manager.screenshot({
          path: "test-results/rujira-connect-trezor-prompt.png",
          fullPage: true,
        });
        await manager
          .getByRole("button", { name: "Use this wallet", exact: true })
          .click();
      }
      if (bitcoinOnly) {
        await expect(
          manager.getByText(/Your Trezor has Bitcoin-only firmware/)
        ).toBeVisible();
        const state: unknown = await manager.evaluate(
          async (): Promise<unknown> =>
            chrome.runtime.sendMessage({ action: "state" })
        );
        expect(state).toMatchObject({
          ok: true,
          result: { accounts: [], sources: [] },
        });
        const rejected: unknown = await manager.evaluate(
          async (): Promise<unknown> =>
            chrome.runtime.sendMessage({
              action: "register",
              source: "trezor",
              chain: "THOR",
              accountIndex: 0,
              profile: "evm",
            })
        );
        expect(rejected).toMatchObject({
          ok: false,
          error: { code: ERROR_CODES.unsupported },
        });
        await manager.evaluate(async (): Promise<unknown> =>
          chrome.runtime.sendMessage({ action: "lock" })
        );
        await installTrezorFixture(worker);
        await manager
          .getByRole("button", { name: "Add account", exact: true })
          .click();
      }
      await expect(
        manager.locator("article.account .account-address code")
      ).toHaveText(expected);
      await expect(manager.locator("article.account strong")).toHaveText(
        "Trezor Safe 3 · m/44'/60'/0'/0/0"
      );
      await manager
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await expect(manager.locator("article.source")).toHaveCount(1);
      await expect(manager.locator("article.source strong")).toContainText(
        "Trezor Safe 3"
      );
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
