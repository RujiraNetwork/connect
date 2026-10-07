import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { chromium, expect, test } from "@playwright/test";
import { encryptToKeyStore } from "@xchainjs/xchain-crypto";
import { verifyMessage } from "ethers";

import type { Page } from "@playwright/test";

test("registers, scopes permissions, signs, rejects, and locks in the unpacked extension", async () => {
  const profile = await mkdtemp(join(tmpdir(), "rujira-browser-"));
  const path = resolve("packages/extension/dist");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
  const errors: string[] = [];
  const outbound: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        url.hostname !== "127.0.0.1" &&
        url.hostname !== "localhost")
    )
      outbound.push(url.href);
  });
  context.on("page", (page) => {
    page.on("pageerror", (error) => {
      errors.push(error.message);
    });
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).hostname;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${id}/index.html`);
    await manager
      .getByRole("button", { name: "Add an account", exact: true })
      .last()
      .click();
    await manager
      .getByRole("button", { name: "Keystore", exact: true })
      .click();
    const fixture = await encryptToKeyStore(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      "test-only-password"
    );
    await manager.getByLabel("Encrypted keystore").setInputFiles({
      name: "public-test-keystore.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
    await manager
      .getByLabel("Keystore password", { exact: true })
      .first()
      .fill("test-only-password");
    await manager
      .getByRole("button", { name: "Import keystore", exact: true })
      .click();
    await expect(manager.getByRole("status")).toContainText(
      "Keystore imported"
    );
    await manager
      .getByRole("combobox", { name: "Imported keystore", exact: true })
      .selectOption({ label: "My keystore" });
    await manager
      .getByRole("combobox", { name: "Network", exact: true })
      .selectOption("ETH");
    await manager
      .getByRole("button", { name: "Add account", exact: true })
      .click();
    await expect(
      manager.getByText("0x9858EfFD232B4033E47d90003D41EC34EcaEda94", {
        exact: true,
      })
    ).toBeVisible();
    await manager
      .getByRole("button", { name: "+ Add another account", exact: true })
      .click();
    await manager
      .getByRole("button", { name: "Keystore", exact: true })
      .click();
    await manager
      .getByRole("combobox", { name: "Imported keystore", exact: true })
      .selectOption({ label: "My keystore" });
    await manager
      .getByRole("combobox", { name: "Network", exact: true })
      .selectOption("BTC");
    await manager.getByLabel("Account index", { exact: true }).fill("1");
    await manager
      .getByRole("button", { name: "Add account", exact: true })
      .click();
    await expect(manager.locator("article.account")).toHaveCount(2);
    await expect(
      manager
        .locator("article.account")
        .filter({ has: manager.locator('[data-network="BTC"]') })
        .locator(".account-path")
    ).toContainText("m/84'/0'/1'/0/0");
    await expect(
      manager
        .locator("article.account")
        .filter({ has: manager.locator('[data-network="ETH"]') })
        .locator(".account-path")
    ).toHaveCount(0);
    await expect(manager.locator('[data-network="BTC"] svg')).toBeVisible();
    await expect(manager.locator('[data-network="ETH"] svg')).toBeVisible();
    await manager.screenshot({
      path: "test-results/rujira-connect-accounts.png",
      fullPage: true,
    });

    await manager
      .getByRole("button", { name: "+ Add another account", exact: true })
      .click();
    await manager.getByRole("button", { name: "Ledger", exact: true }).click();
    await manager
      .getByRole("combobox", { name: "Network", exact: true })
      .selectOption("BTC");
    await manager.getByLabel("Account index", { exact: true }).fill("101");
    await expect(
      manager.getByRole("button", {
        name: "Choose Ledger and add account",
        exact: true,
      })
    ).toBeDisabled();
    await expect(manager.locator("#account-index-help")).toContainText(
      "0 to 100"
    );
    await manager.getByLabel("Account index", { exact: true }).fill("");
    await expect(
      manager.getByRole("button", {
        name: "Choose Ledger and add account",
        exact: true,
      })
    ).toBeDisabled();
    await manager.getByLabel("Account index", { exact: true }).fill("100");
    await expect(
      manager.getByRole("button", {
        name: "Choose Ledger and add account",
        exact: true,
      })
    ).toBeEnabled();
    await expect(
      manager.evaluate(() =>
        chrome.runtime.sendMessage({
          action: "register",
          source: "ledger",
          chain: "BTC",
          profile: "default",
          accountIndex: 101,
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: -32602 } });
    await manager
      .getByRole("button", { name: "Accounts", exact: true })
      .click();

    const dapp = await context.newPage();
    await dapp.goto("http://127.0.0.1:5174");
    await expect
      .poll(() => dapp.evaluate(() => Boolean(window.rujira)))
      .toBe(true);
    expect(await dapp.evaluate(() => window.rujira?.getAccounts())).toEqual([]);
    let approval = await openApproval(dapp, "Connect registered accounts");
    await approval
      .getByRole("checkbox", {
        name: "Ethereum My keystore · Ethereum 1",
        exact: true,
      })
      .check();
    await approval
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await expect(dapp.locator("#output")).toContainText("0x9858");
    await approval.close();
    approval = await openApproval(dapp, "Request signature");
    await expect(
      approval.getByText("Hello from Rujira Connect", { exact: true })
    ).toBeVisible();
    await approval.screenshot({
      path: "test-results/rujira-connect-approval.png",
      fullPage: true,
    });
    await approval.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(dapp.locator("#output")).toContainText('"payload": "0x');
    const signed: unknown = JSON.parse(
      await dapp.locator("#output").innerText()
    );
    if (
      typeof signed !== "object" ||
      signed === null ||
      !("payload" in signed) ||
      typeof signed.payload !== "string"
    )
      throw new Error("Missing signature");
    expect(verifyMessage("Hello from Rujira Connect", signed.payload)).toBe(
      "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
    );
    await approval.close();
    await dapp
      .locator("#native")
      .fill(
        JSON.stringify({ method: "personal_sign", params: { message: "ff" } })
      );
    approval = await openApproval(dapp, "Sign native request");
    await expect(
      approval.getByRole("button", { name: "Sign", exact: true })
    ).toBeDisabled();
    await approval.getByRole("checkbox").check();
    await approval.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(dapp.locator("#output")).toContainText('"payload": "0x');
    await approval.close();

    const otherOrigin = await context.newPage();
    await otherOrigin.goto("http://localhost:5174");
    expect(
      await otherOrigin.evaluate(() => window.rujira?.getAccounts())
    ).toEqual([]);
    await expect(
      dapp.evaluate(async () => {
        try {
          await window.rujira?.ethereum.request({
            method: "eth_sendTransaction",
            params: [{}],
          });
          return 0;
        } catch (error) {
          return typeof error === "object" && error !== null && "code" in error
            ? error.code
            : 0;
        }
      })
    ).resolves.toBe(4200);
    approval = await openApproval(dapp, "Request signature");
    await approval
      .getByRole("button", { name: "Decline", exact: true })
      .click();
    await expect(dapp.locator("#output")).toContainText("declined");
    await approval.close();
    await manager.getByRole("button", { name: "Lock", exact: true }).click();
    approval = await openApproval(dapp, "Request signature");
    await expect(
      approval.getByLabel("Keystore password", { exact: true })
    ).toBeVisible();
    await expect(
      approval.getByRole("button", { name: "Sign", exact: true })
    ).toBeDisabled();
    await approval
      .getByRole("button", { name: "Decline", exact: true })
      .click();
    await expect(dapp.locator("#output")).toContainText("declined");
    await approval.close();
    await manager.getByRole("button", { name: "Sites", exact: true }).click();
    await manager
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    expect(await dapp.evaluate(() => window.rujira?.getAccounts())).toEqual([]);
    await manager.screenshot({
      path: "test-results/rujira-connect.png",
      fullPage: true,
    });
    approval = await openApproval(dapp, "Connect registered accounts");
    await approval
      .getByRole("checkbox", {
        name: "Ethereum My keystore · Ethereum 1",
        exact: true,
      })
      .check();
    await approval
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await expect(
      approval.getByRole("heading", { name: "Accounts shared", exact: true })
    ).toBeVisible();
    await approval.close();
    await dapp.evaluate(() => {
      window.rujira?.ethereum.on("accountsChanged", (addresses) => {
        document.body.dataset.addressChange = JSON.stringify(addresses);
      });
    });
    approval = await openApproval(dapp, "Request signature");
    await manager
      .getByRole("button", { name: "Accounts", exact: true })
      .click();
    await manager
      .getByRole("button", {
        name: "Remove My keystore · Ethereum 1 account",
        exact: true,
      })
      .click();
    await expect(manager.getByRole("status")).toContainText(
      "Ethereum account removed"
    );
    await expect(manager.locator("article.account")).toHaveCount(1);
    await expect(
      manager.locator('article.account [data-network="BTC"]')
    ).toBeVisible();
    await expect(dapp.locator("#output")).toContainText("removed");
    await expect(dapp.locator("body")).toHaveAttribute(
      "data-address-change",
      "[]"
    );
    expect(await dapp.evaluate(() => window.rujira?.getAccounts())).toEqual([]);
    await approval.close();
    await manager.getByRole("button", { name: "Sites", exact: true }).click();
    await expect(
      manager.getByText("No sites have access yet.", { exact: true })
    ).toBeVisible();
    await manager
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await expect(
      manager.getByText("My keystore", { exact: true })
    ).toBeVisible();
    const networkGuard = await worker.evaluate(async () => {
      try {
        await fetch("https://example.com/rujira-offline-check");
        return "sent";
      } catch (error) {
        return error instanceof Error ? error.message : "blocked";
      }
    });
    expect(networkGuard).toContain("Network access is disabled");
    const trezor = await manager.evaluate(async (): Promise<unknown> =>
      chrome.runtime.sendMessage({
        action: "register",
        source: "trezor",
        chain: "ETH",
        accountIndex: 0,
        profile: "default",
      })
    );
    expect(trezor).toMatchObject({ ok: false, error: { code: 4001 } });
    expect(outbound).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

async function openApproval(dapp: Page, button: string): Promise<Page> {
  const created = dapp.context().waitForEvent("page");
  await dapp.getByRole("button", { name: button, exact: true }).click();
  const approval = await created;
  await approval.waitForURL(/view=approve/);
  return approval;
}
