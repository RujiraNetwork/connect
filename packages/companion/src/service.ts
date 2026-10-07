import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ConnectError,
  ERROR_CODES,
  accountPath,
  accountSchema,
  payloadDigest,
  supportedMethods,
  canonicalJson,
} from "@rujira/connect-core";
import { z } from "zod";

import { NativeWalletEngine } from "./engine";
import { validateMoneroAccount, validateNode } from "./policy";

import type { EngineConfig } from "./engine";
import type { Account, CompanionRequest } from "@rujira/connect-core";

export class CompanionService {
  private config: EngineConfig;
  private engine: NativeWalletEngine;
  private busy = false;
  constructor(config: EngineConfig) {
    this.config = { ...config, node: validateNode(config.node) };
    this.engine = new NativeWalletEngine(this.config);
  }
  private async accounts(): Promise<Account[]> {
    try {
      return accountSchema
        .array()
        .parse(
          JSON.parse(
            await readFile(
              join(this.config.dataDirectory, "accounts.json"),
              "utf8"
            )
          ) as unknown
        );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return [];
      throw error;
    }
  }
  private async save(accounts: Account[]): Promise<void> {
    await mkdir(this.config.dataDirectory, { recursive: true, mode: 0o700 });
    await this.saveFile("accounts.json", accounts);
  }
  private async saveFile(name: string, value: unknown): Promise<void> {
    const temporary = join(
      this.config.dataDirectory,
      `.${name}-${crypto.randomUUID()}`
    );
    await writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, join(this.config.dataDirectory, name));
  }
  close(): Promise<void> {
    return this.engine.close();
  }

  async request(request: CompanionRequest): Promise<unknown> {
    if (request.method === "status")
      return {
        version: 1,
        engineAvailable: await this.engine.available(),
        node: this.config.node,
        busy: this.busy,
      };
    if (this.busy)
      throw new ConnectError(
        ERROR_CODES.busy,
        "The Monero companion is already handling a request"
      );
    this.busy = true;
    try {
      switch (request.method) {
        case "lock":
          await this.close();
          return null;
        case "setNode": {
          await this.close();
          const config = { ...this.config, node: validateNode(request.url) };
          await this.saveFile("config.json", config);
          this.config = config;
          this.engine = new NativeWalletEngine(this.config);
          return { node: this.config.node };
        }
        case "register": {
          const generated = accountSchema.parse({
            id: crypto.randomUUID(),
            sourceId: request.sourceId,
            source: request.source,
            chain: "XMR",
            address: request.address ?? "pending",
            path: accountPath("XMR", request.accountIndex, request.source),
            label: `${request.source === "ledger" ? "Ledger" : request.source === "trezor" ? "Trezor" : "Keystore"} · Monero ${String(request.accountIndex + 1)}`,
            scheme: "native",
            verifiedAt: Date.now(),
            methods: supportedMethods("XMR", request.source),
          });
          const account = { ...(request.account ?? generated) };
          if (
            account.chain !== "XMR" ||
            account.source !== request.source ||
            account.sourceId !== request.sourceId ||
            (account.path !== generated.path &&
              !(
                account.source === "ledger" &&
                account.path === "m/44'/128'/0'/0/0"
              ))
          )
            throw new ConnectError(
              ERROR_CODES.invalid,
              "The Monero wallet setup does not match the connected account."
            );
          const accounts = await this.accounts();
          const existing = accounts.find((entry) => entry.id === account.id);
          if (existing) {
            if (canonicalJson(existing) !== canonicalJson(account)) {
              if (
                existing.address !== account.address ||
                existing.source !== account.source ||
                (existing.path !== account.path &&
                  !(
                    account.source === "ledger" &&
                    account.path === "device" &&
                    existing.path === "m/44'/128'/0'/0/0"
                  ))
              )
                throw new ConnectError(
                  ERROR_CODES.unauthorized,
                  "The connected Monero account has changed."
                );
              await this.save(
                accounts.map((entry) =>
                  entry.id === account.id ? account : entry
                )
              );
            }
            return account;
          }
          const expectedAddress = request.account?.address;
          if (request.source === "keystore") {
            if (!request.spendKey || !request.viewKey || !request.address)
              throw new ConnectError(
                ERROR_CODES.invalid,
                "Unlock the keystore in Rujira Connect before setting up Monero signing."
              );
            const rpc = await this.engine.open(undefined, request.password);
            await rpc.call("generate_from_keys", {
              filename: account.id,
              address: request.address,
              spendkey: request.spendKey,
              viewkey: request.viewKey,
              password: request.password,
              restore_height: request.restoreHeight,
              autosave_current: true,
            });
            const address = z
              .object({ address: z.string() })
              .parse(await rpc.call("get_address")).address;
            if (address !== request.address)
              throw new ConnectError(
                ERROR_CODES.invalid,
                "Monero engine returned another address"
              );
          } else {
            if (request.spendKey || request.viewKey || request.address)
              throw new ConnectError(
                ERROR_CODES.invalid,
                "Hardware registration must derive its address on the device"
              );
            await this.engine.provisionHardware(
              account.id,
              request.password,
              request.source,
              account.path,
              request.restoreHeight
            );
            const rpc = await this.engine.open(account.id, request.password);
            account.address = z
              .object({ address: z.string().length(95) })
              .parse(await rpc.call("get_address")).address;
          }
          if (expectedAddress && account.address !== expectedAddress)
            throw new ConnectError(
              ERROR_CODES.unauthorized,
              "The companion wallet does not match your connected Monero address."
            );
          accounts.push(account);
          await this.save(accounts);
          return account;
        }
        case "sync": {
          const account = (await this.accounts()).find(
            (entry) => entry.id === request.accountId
          );
          if (!account)
            throw new ConnectError(
              ERROR_CODES.unauthorized,
              "Monero account is not registered"
            );
          const rpc = await this.engine.open(account.id, request.password);
          return await rpc.call("refresh");
        }
        case "sign": {
          const account = (await this.accounts()).find(
            (entry) => entry.id === request.account.id
          );
          if (!account)
            throw new ConnectError(
              ERROR_CODES.unauthorized,
              "Monero account is not registered"
            );
          validateMoneroAccount(
            account,
            request.account,
            request.request,
            request.maxFee
          );
          if (
            (await payloadDigest({
              method: "sign",
              params: request.request,
            })) !== request.approvalDigest
          )
            throw new ConnectError(
              ERROR_CODES.invalid,
              "Monero approval digest does not match the request"
            );
          const rpc = await this.engine.open(account.id, request.password);
          const address = z
            .object({ address: z.string() })
            .parse(await rpc.call("get_address")).address;
          if (address !== account.address)
            throw new ConnectError(
              ERROR_CODES.unauthorized,
              "Native wallet address changed"
            );
          await rpc.call("auto_refresh", { enable: false });
          await rpc.call("refresh");
          for (const destination of request.request.params.destinations) {
            const validated = z
              .object({ valid: z.boolean(), nettype: z.string() })
              .parse(
                await rpc.call("validate_address", {
                  address: destination.address,
                  any_net_type: false,
                  allow_openalias: false,
                })
              );
            if (!validated.valid || validated.nettype !== "mainnet")
              throw new ConnectError(
                ERROR_CODES.invalid,
                "Destination must be a valid mainnet Monero address"
              );
          }
          // Native wallet2 performs preparation and device signing. sign_transfer cannot sign hardware wallets.
          const signed = z
            .object({
              tx_hash: z.string().regex(/^[a-f0-9]{64}$/),
              tx_blob: z.string().regex(/^(?:[a-f0-9]{2})+$/),
              fee: z.union([
                z.number().int().safe().nonnegative(),
                z.string().regex(/^\d+$/),
              ]),
              amount: z.union([
                z.number().int().safe().nonnegative(),
                z.string().regex(/^\d+$/),
              ]),
            })
            .parse(
              await rpc.call("transfer", {
                destinations: request.request.params.destinations.map(
                  (entry) => ({
                    address: entry.address,
                    amount: safeAtomic(entry.amount),
                  })
                ),
                account_index: 0,
                priority: request.request.params.priority,
                do_not_relay: true,
                get_tx_hex: true,
                get_tx_key: false,
                get_tx_metadata: false,
              })
            );
          const amount = request.request.params.destinations.reduce(
            (sum, entry) => sum + BigInt(entry.amount),
            0n
          );
          if (
            BigInt(signed.fee) > BigInt(request.maxFee) ||
            BigInt(signed.amount) !== amount
          )
            throw new ConnectError(
              ERROR_CODES.invalid,
              "Native transaction exceeds the approved fee or amount"
            );
          return {
            transactionHex: signed.tx_blob,
            transactionHash: signed.tx_hash,
            fee: String(signed.fee),
            amount: String(signed.amount),
          };
        }
      }
    } finally {
      await this.close();
      this.busy = false;
    }
  }
}

function safeAtomic(amount: string): number {
  const value = BigInt(amount);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ConnectError(
      ERROR_CODES.unsupported,
      "This native RPC adapter requires amounts below the safe JSON integer limit"
    );
  return Number(value);
}
