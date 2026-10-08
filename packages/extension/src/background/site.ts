import { ConnectError, ERROR_CODES, originOf } from "@rujira/connect-core";

/** Chrome grants activeTab when the user opens the toolbar popup. */
export async function activateSite(
  windowId: number
): Promise<{ origin: string | null }> {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab?.id === undefined || !tab.url) return { origin: null };
  let origin: string;
  try {
    origin = originOf(tab.url);
  } catch {
    return { origin: null };
  }
  try {
    const [bridge] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      files: ["content.global.js"],
      world: "ISOLATED",
      injectImmediately: true,
    });
    if (!bridge?.documentId || bridge.frameId !== 0)
      throw new Error("Missing top-level document");
    // Bind the provider to the same document, even if navigation occurs between
    // the two injections. Install the bridge first so discovery can request it.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, documentIds: [bridge.documentId] },
      files: ["page.global.js"],
      world: "MAIN",
      injectImmediately: true,
    });
    return { origin };
  } catch {
    throw new ConnectError(
      ERROR_CODES.disconnected,
      "Open Connect from the browser toolbar on this page and try again."
    );
  }
}
