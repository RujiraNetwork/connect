import {
  CHANNEL,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  pageMessageSchema,
} from "@rujira/connect-core";

if (window === window.top) {
  let port: chrome.runtime.Port | undefined;
  const pending = new Set<string>();
  let active = true;
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (
      sender.id === chrome.runtime.id &&
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "rujira-document-check"
    )
      respond({ active });
    return false;
  });
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (!active || event.source !== window || event.origin !== location.origin)
      return;
    const parsed = pageMessageSchema.safeParse(event.data);
    if (
      !parsed.success ||
      JSON.stringify(event.data).length > MAX_MESSAGE_BYTES ||
      pending.has(parsed.data.id)
    )
      return;
    if (pending.size >= 8) return;
    pending.add(parsed.data.id);
    port ??= connect();
    port.postMessage(parsed.data);
  });
  function connect(): chrome.runtime.Port {
    const current = chrome.runtime.connect({ name: "rujira-dapp" });
    current.onMessage.addListener((message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const record = message as Record<string, unknown>;
      if (record.direction === "response" && typeof record.id === "string")
        pending.delete(record.id);
      window.postMessage(
        { ...record, channel: CHANNEL, version: PROTOCOL_VERSION },
        location.origin
      );
    });
    current.onDisconnect.addListener(() => {
      if (port === current) port = undefined;
      for (const id of pending)
        window.postMessage(
          {
            channel: CHANNEL,
            version: PROTOCOL_VERSION,
            direction: "response",
            id,
            response: {
              ok: false,
              error: {
                code: 4900,
                message: "Rujira Connect restarted. Please retry the request.",
              },
            },
          },
          location.origin
        );
      pending.clear();
    });
    return current;
  }
  window.addEventListener("pagehide", () => {
    active = false;
    port?.disconnect();
  });
}
