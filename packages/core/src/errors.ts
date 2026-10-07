import type { SerializedError } from "./protocol";

export const ERROR_CODES = {
  rejected: 4001,
  unauthorized: 4100,
  unsupported: 4200,
  disconnected: 4900,
  wrongChain: 4901,
  busy: -32002,
  invalid: -32602,
  internal: -32603,
  locked: -32003,
  expired: -32004,
} as const;

export class ConnectError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "ConnectError";
    this.code = code;
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof ConnectError)
    return { code: error.code, message: error.message.slice(0, 1024) };
  // Vendor errors can include payloads, passwords, or device internals. Never forward them to a dapp.
  return {
    code: ERROR_CODES.internal,
    message: "The signing operation failed. Check Rujira Connect for details.",
  };
}
