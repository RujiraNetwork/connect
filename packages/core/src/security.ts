import { CHAINS } from "./chains";
import { ConnectError, ERROR_CODES } from "./errors";

import type { Account, Grant, SignRequest } from "./protocol";

export function originOf(url: string): string {
  const parsed = new URL(url);
  const local =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local))
    throw new ConnectError(
      ERROR_CODES.unauthorized,
      "Connect requires HTTPS or localhost"
    );
  return parsed.origin;
}

export function authorizedAccounts(
  origin: string,
  accounts: readonly Account[],
  grants: readonly Grant[]
): Account[] {
  const grant = grants.find((entry) => entry.origin === origin);
  return accounts.filter((account) => grant?.accountIds.includes(account.id));
}

export function authorizeSign(
  origin: string,
  request: SignRequest,
  accounts: readonly Account[],
  grants: readonly Grant[]
): Account {
  const account = authorizedAccounts(origin, accounts, grants).find(
    (entry) => entry.id === request.accountId
  );
  if (!account)
    throw new ConnectError(
      ERROR_CODES.unauthorized,
      "This site is not permitted to use this account"
    );
  validateSignAccount(account, request);
  return account;
}

export function validateSignAccount(
  account: Account,
  request: SignRequest
): void {
  if (account.chain !== request.chain)
    throw new ConnectError(
      ERROR_CODES.wrongChain,
      "The signing network does not match the account"
    );
  if (!account.methods.includes(request.method))
    throw new ConnectError(
      ERROR_CODES.unsupported,
      "This account does not support this signing method"
    );
  const chain = CHAINS[account.chain];
  if (request.method === "eth_signTransaction") {
    if (BigInt(request.params.chainId) !== BigInt(chain.evmChainId ?? -1))
      throw new ConnectError(
        ERROR_CODES.wrongChain,
        "Transaction chain ID does not match the selected network"
      );
    if (
      request.params.from !== undefined &&
      request.params.from.toLowerCase() !== account.address.toLowerCase()
    )
      throw new ConnectError(
        ERROR_CODES.unauthorized,
        "Transaction sender does not match the account"
      );
  }
  if (
    request.method === "signAmino" &&
    request.params.chain_id !== chain.nativeChainId
  )
    throw new ConnectError(
      ERROR_CODES.wrongChain,
      "Amino chain ID does not match the selected network"
    );
  if (
    request.method === "signDirect" &&
    request.params.chainId !== chain.nativeChainId
  )
    throw new ConnectError(
      ERROR_CODES.wrongChain,
      "SignDoc chain ID does not match the selected network"
    );
  if (
    request.method === "eth_signTypedData_v4" &&
    request.params.domain.chainId !== undefined
  ) {
    const id = request.params.domain.chainId;
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      BigInt(id) !== BigInt(chain.evmChainId ?? -1)
    )
      throw new ConnectError(
        ERROR_CODES.wrongChain,
        "Typed-data chain ID does not match the selected network"
      );
  }
  if (
    request.method === "signXrpTransaction" &&
    request.params.Account !== account.address
  )
    throw new ConnectError(
      ERROR_CODES.unauthorized,
      "XRP transaction sender does not match the account"
    );
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry: unknown) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new ConnectError(ERROR_CODES.invalid, "Request contains non-JSON data");
}

export async function payloadDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value))
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
