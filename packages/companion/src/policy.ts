import { isIP } from "node:net";

import { ConnectError, ERROR_CODES, canonicalJson } from "@rujira/connect-core";

import type { Account, SignRequest } from "@rujira/connect-core";

export function validateNode(value: string): string {
  const url = new URL(value);
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  )
    throw new ConnectError(
      ERROR_CODES.invalid,
      "Use an HTTPS Monero node, or an HTTP node on localhost"
    );
  if (
    url.hostname.length > 253 ||
    (!local && url.protocol !== "https:") ||
    (isIP(url.hostname) === 6 && url.hostname.includes("%"))
  )
    throw new ConnectError(ERROR_CODES.invalid, "Invalid Monero node");
  return url.origin;
}

export function validateMoneroAccount(
  stored: Account,
  requested: Account,
  request: SignRequest,
  maxFee: string
): asserts request is Extract<SignRequest, { method: "signMoneroTransfer" }> {
  if (
    canonicalJson(stored) !== canonicalJson(requested) ||
    request.accountId !== stored.id ||
    request.chain !== "XMR" ||
    request.method !== "signMoneroTransfer"
  )
    throw new ConnectError(
      ERROR_CODES.unauthorized,
      "Monero request does not match the registered wallet"
    );
  if (request.params.accountIndex !== 0)
    throw new ConnectError(
      ERROR_CODES.unsupported,
      "Register a separate Monero wallet to use another account"
    );
  if (request.params.memo)
    throw new ConnectError(
      ERROR_CODES.unsupported,
      "This native Monero adapter uses standard transfers. Use a memo-less THORChain deposit address."
    );
  if (
    request.params.maxFee !== maxFee ||
    BigInt(maxFee) <= 0n ||
    request.params.destinations.some((entry) => BigInt(entry.amount) <= 0n)
  )
    throw new ConnectError(
      ERROR_CODES.invalid,
      "Monero transfer needs positive amounts and an exact maximum fee"
    );
}
