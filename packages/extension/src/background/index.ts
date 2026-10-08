import {
  MAX_MESSAGE_BYTES,
  ConnectError,
  ERROR_CODES,
  originOf,
  publicAccount,
  pageMessageSchema,
  serializeError,
  uiRequestSchema,
} from "@rujira/connect-core";

import { RequestBroker } from "./broker";
import { WalletDriver } from "./driver";
import { blockNetwork } from "./offline";
import { activateSite } from "./site";
import { ChromeStateRepository, removeAccount } from "./storage";

import type { UiRequest } from "@rujira/connect-core";

const repository = new ChromeStateRepository();
blockNetwork();
const driver = new WalletDriver(repository);
const ports = new Set<chrome.runtime.Port>();

async function changed(origin?: string): Promise<void> {
  const state = await repository.load();
  for (const port of ports) {
    try {
      const site = originOf(port.sender?.url ?? "");
      if (!origin || site === origin) {
        const ids =
          state.grants.find((grant) => grant.origin === site)?.accountIds ?? [];
        port.postMessage({
          direction: "event",
          event: "accountsChanged",
          value: state.accounts
            .filter((account) => ids.includes(account.id))
            .map(publicAccount),
        });
      }
    } catch {
      /* Disconnected documents no longer receive account events. */
    }
  }
}

const broker = new RequestBroker(repository, driver, {
  openApproval: async (id) => {
    const window = await chrome.windows.create({
      url: chrome.runtime.getURL(`index.html?view=approve&id=${id}`),
      type: "popup",
      width: 460,
      height: 780,
      focused: true,
    });
    if (window?.id === undefined)
      throw new ConnectError(
        ERROR_CODES.internal,
        "Could not open the approval window"
      );
    return window.id;
  },
  changed,
});

chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  if (
    port.name !== "rujira-dapp" ||
    sender?.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !sender.tab?.id ||
    !sender.url ||
    !sender.documentId
  ) {
    port.disconnect();
    return;
  }
  let origin: string;
  try {
    origin = originOf(sender.url);
    if (sender.origin && sender.origin !== origin)
      throw new Error("Opaque origin");
  } catch {
    port.disconnect();
    return;
  }
  const tabId = sender.tab.id;
  const documentId = sender.documentId;
  let alive = true;
  ports.add(port);
  port.onDisconnect.addListener(() => {
    alive = false;
    ports.delete(port);
    broker.documentClosed(documentId);
  });
  const inFlight = new Set<string>();
  port.onMessage.addListener((message: unknown) => {
    const parsed = pageMessageSchema.safeParse(message);
    if (
      !parsed.success ||
      JSON.stringify(message).length > MAX_MESSAGE_BYTES ||
      inFlight.has(parsed.data.id)
    )
      return;
    const { id, request } = parsed.data;
    if (inFlight.size >= 8) {
      port.postMessage({
        direction: "response",
        id,
        response: {
          ok: false,
          error: {
            code: ERROR_CODES.busy,
            message: "Too many pending requests",
          },
        },
      });
      return;
    }
    inFlight.add(id);
    broker
      .request(request, {
        origin,
        documentId,
        current: async () => {
          if (!alive) return false;
          try {
            const response: unknown = await chrome.tabs.sendMessage(
              tabId,
              { type: "rujira-document-check" },
              { documentId, frameId: 0 }
            );
            return (
              typeof response === "object" &&
              response !== null &&
              "active" in response &&
              response.active === true
            );
          } catch {
            return false;
          }
        },
      })
      .then((result) => {
        if (alive)
          port.postMessage({
            direction: "response",
            id,
            response: { ok: true, result },
          });
      })
      .catch((error: unknown) => {
        if (alive)
          port.postMessage({
            direction: "response",
            id,
            response: { ok: false, error: serializeError(error) },
          });
      })
      .finally(() => {
        inFlight.delete(id);
      })
      .catch(() => {
        alive = false;
        broker.documentClosed(documentId);
      });
  });
});

function trustedUi(sender: chrome.runtime.MessageSender): boolean {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url ||
    (sender.frameId !== undefined && sender.frameId !== 0)
  )
    return false;
  const url = new URL(sender.url);
  return (
    url.protocol === "chrome-extension:" &&
    url.host === chrome.runtime.id &&
    url.pathname === "/index.html"
  );
}

async function ui(request: UiRequest): Promise<unknown> {
  switch (request.action) {
    case "state":
      return driver.state();
    case "activateSite":
      return activateSite(request.windowId);
    case "pending":
      return broker.view(request.id);
    case "approve":
      return broker.approve(
        request.id,
        request.digest,
        request.accountIds,
        request.acknowledgeRaw,
        request.password
      );
    case "reject":
      broker.reject(request.id);
      return null;
    case "register":
      return driver.register(request);
    case "import":
      await driver.import(request);
      return driver.state();
    case "unlock":
      await driver.unlock(request.sourceId, request.password);
      return driver.state();
    case "lock":
      broker.cancelAll();
      await driver.lock();
      await changed();
      return driver.state();
    case "forget": {
      broker.cancelAll();
      driver.sessions.lock(request.sourceId);
      await repository.update((state) => {
        const ids = state.accounts
          .filter((account) => account.sourceId === request.sourceId)
          .map((account) => account.id);
        return {
          ...state,
          sources: state.sources.filter(
            (source) => source.id !== request.sourceId
          ),
          accounts: state.accounts.filter(
            (account) => account.sourceId !== request.sourceId
          ),
          grants: state.grants
            .map((grant) => ({
              ...grant,
              accountIds: grant.accountIds.filter((id) => !ids.includes(id)),
            }))
            .filter((grant) => grant.accountIds.length > 0),
        };
      });
      await changed();
      return driver.state();
    }
    case "removeAccount":
      broker.accountRemoved(request.accountId);
      await repository.update((state) =>
        removeAccount(state, request.accountId)
      );
      await changed();
      return driver.state();
    case "revoke": {
      await repository.update((state) => ({
        ...state,
        grants: state.grants.filter((grant) => grant.origin !== request.origin),
      }));
      await changed(request.origin);
      return driver.state();
    }
    case "deviceGranted":
      await driver.lock();
      return null;
    case "deviceResponse":
      driver.deviceResponse(request);
      return null;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!trustedUi(sender)) return false;
  const parsed = uiRequestSchema.safeParse(message);
  if (!parsed.success || JSON.stringify(message).length > MAX_MESSAGE_BYTES) {
    respond({
      ok: false,
      error: {
        code: ERROR_CODES.invalid,
        message: "Invalid extension request",
      },
    });
    return false;
  }
  if (
    parsed.data.action === "activateSite" &&
    new URL(sender.url ?? "").searchParams.get("view") !== "popup"
  ) {
    respond({
      ok: false,
      error: {
        code: ERROR_CODES.unauthorized,
        message: "Open Connect from the browser toolbar to enable this site.",
      },
    });
    return false;
  }
  ui(parsed.data)
    .then((result) => {
      respond({ ok: true, result });
    })
    .catch((error: unknown) => {
      respond({ ok: false, error: serializeError(error) });
    });
  return true;
});
chrome.windows.onRemoved.addListener((id) => {
  broker.windowClosed(id);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("lock:")) {
    driver.sessions.lock(alarm.name.slice(5));
    changed().catch(() => {
      /* This best-effort notification has no user-visible result. */
    });
  }
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .then(() =>
      chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    )
    .catch(() => {
      /* This best-effort notification has no user-visible result. */
    });
});
