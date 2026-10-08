import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test } from "@playwright/test";

import { activateConnect } from "./activation";

import type { Worker } from "@playwright/test";

test("requires toolbar activation and confines the bridge to the selected document", async () => {
  const profile = await mkdtemp(join(tmpdir(), "rujira-permissions-"));
  const path = resolve("packages/extension/dist");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${path}`,
      `--load-extension=${path}`,
      "--enable-unsafe-extension-debugging",
    ],
  });
  const errors: string[] = [];
  context.on("page", (page) => {
    page.on("pageerror", (error) => {
      errors.push(error.message);
    });
  });
  for (const origin of ["https://one.example", "https://two.example"])
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          new URL(route.request().url()).pathname === "/frame"
            ? "<!doctype html><title>Nested fixture</title><body></body>"
            : '<!doctype html><title>Permission fixture</title><body><iframe title="Nested app" src="/frame"></iframe></body>',
      })
    );
  await context.route("http://127.0.0.1:5174/permission-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Local fixture</title><body></body>",
    })
  );
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).hostname;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${id}/index.html`);
    const sameOrigin = await context.newPage();
    await sameOrigin.goto("https://one.example/?unselected");
    const selected = await context.newPage();
    await selected.goto("https://one.example/?selected");
    expect(await selected.evaluate(() => Boolean(window.rujira))).toBe(false);
    expect(await sameOrigin.evaluate(() => Boolean(window.rujira))).toBe(false);
    await expectInjectionDenied(worker);

    const restricted: unknown = await manager.evaluate(
      async (): Promise<unknown> => {
        const window = await chrome.windows.getCurrent();
        return chrome.runtime.sendMessage({
          action: "activateSite",
          windowId: window.id,
        });
      }
    );
    expect(restricted).toMatchObject({ ok: false, error: { code: 4100 } });
    expect(await selected.evaluate(() => Boolean(window.rujira))).toBe(false);

    await selected.evaluate(() => {
      window.addEventListener(
        "eip6963:announceProvider",
        () => {
          window.rujira
            ?.getCapabilities()
            .then((capabilities) => {
              document.body.dataset.discovered = String(
                capabilities.signingOnly
              );
            })
            .catch(() => {
              document.body.dataset.discovered = "failed";
            });
        },
        { once: true }
      );
    });
    await activateConnect(selected, id, manager);
    await expect(selected.locator("body")).toHaveAttribute(
      "data-discovered",
      "true"
    );
    expect(await sameOrigin.evaluate(() => Boolean(window.rujira))).toBe(false);
    const nested = selected.frames().find((frame) => frame.parentFrame());
    if (!nested) throw new Error("Missing nested frame fixture");
    expect(await nested.evaluate(() => Boolean(window.rujira))).toBe(false);

    await selected.evaluate(() => {
      let announcements = 0;
      window.addEventListener("eip6963:announceProvider", () => {
        document.body.dataset.announcements = String(++announcements);
      });
    });
    await activateConnect(selected, id, manager);
    await selected.evaluate(() => {
      window.dispatchEvent(new Event("eip6963:requestProvider"));
    });
    await expect(selected.locator("body")).toHaveAttribute(
      "data-announcements",
      "1"
    );
    const opened = context.waitForEvent("page");
    const connection = selected.evaluate(async () => {
      try {
        await window.rujira?.connect({ chains: ["BTC"] });
        return "connected";
      } catch {
        return "declined";
      }
    });
    const approval = await opened;
    await approval.waitForURL(/view=approve/);
    expect(
      context.pages().filter((page) => page.url().includes("view=approve"))
    ).toHaveLength(1);
    await approval
      .getByRole("button", { name: "Decline", exact: true })
      .click();
    expect(await connection).toBe("declined");
    await approval.close();

    await selected.reload();
    expect(await selected.evaluate(() => Boolean(window.rujira))).toBe(false);
    await activateConnect(selected, id, manager);
    expect(await selected.evaluate(() => window.rujira?.getAccounts())).toEqual(
      []
    );
    await selected.goto("https://two.example/");
    expect(await selected.evaluate(() => Boolean(window.rujira))).toBe(false);
    await expectInjectionDenied(worker);
    await activateConnect(selected, id, manager);
    expect(await selected.evaluate(() => window.rujira?.getAccounts())).toEqual(
      []
    );

    // Local development needs the same user gesture, without extra host access.
    await selected.goto("http://127.0.0.1:5174/permission-fixture");
    expect(await selected.evaluate(() => Boolean(window.rujira))).toBe(false);
    await expectInjectionDenied(worker);
    await activateConnect(selected, id, manager);
    expect(await sameOrigin.evaluate(() => Boolean(window.rujira))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

async function expectInjectionDenied(worker: Worker): Promise<void> {
  const denied = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tab?.id === undefined) throw new Error("Missing test tab");
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        files: ["page.global.js"],
        world: "MAIN",
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(denied).toBe(true);
}
