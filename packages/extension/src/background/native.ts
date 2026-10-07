import {
  COMPANION_NAME,
  ConnectError,
  ERROR_CODES,
  responseSchema,
} from "@rujira/connect-core";
import { z } from "zod";

import type { CompanionRequest } from "@rujira/connect-core";

export class CompanionClient {
  private port: chrome.runtime.Port | undefined;
  private readonly pending = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  request(request: CompanionRequest): Promise<unknown> {
    this.port ??= this.connect();
    const port = this.port;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(
          new ConnectError(ERROR_CODES.expired, "The companion request expired")
        );
      }, 290_000);
      this.pending.set(request.id, { resolve, reject, timer });
      port.postMessage(request);
    });
  }
  private connect(): chrome.runtime.Port {
    const port = chrome.runtime.connectNative(COMPANION_NAME);
    port.onMessage.addListener((message: unknown) => {
      const identity = z.object({ id: z.string().uuid() }).safeParse(message);
      if (!identity.success || typeof message !== "object" || message === null)
        return;
      const { id, ...response } = message as Record<string, unknown>;
      const parsed = responseSchema.safeParse(response);
      const pending = this.pending.get(identity.data.id);
      if (!parsed.success || !pending || id !== identity.data.id) return;
      clearTimeout(pending.timer);
      this.pending.delete(identity.data.id);
      if (parsed.data.ok) pending.resolve(parsed.data.result);
      else
        pending.reject(
          new ConnectError(parsed.data.error.code, parsed.data.error.message)
        );
    });
    port.onDisconnect.addListener(() => {
      // Consume lastError here; native-host errors never include passwords in the UI.
      const disconnected = chrome.runtime.lastError;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new ConnectError(
            ERROR_CODES.disconnected,
            disconnected
              ? "Install the Rujira Monero companion and its wallet engine, then try again"
              : "The Rujira companion disconnected"
          )
        );
      }
      this.pending.clear();
      this.port = undefined;
    });
    return port;
  }
  disconnect(): void {
    this.port?.disconnect();
    this.port = undefined;
  }
}
