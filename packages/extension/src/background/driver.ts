import {
  CHAINS,
  ConnectError,
  ERROR_CODES,
  accountPath,
  accountSchema,
  supportedMethods,
  uiStateSchema,
  validateSignAccount,
} from "@rujira/connect-core";
import { computeAddress } from "ethers";

import { saveRegisteredAccount } from "./storage";
import { base64, fromHex } from "../adapters/bytes";
import { KeystoreSessions } from "../adapters/keystore";
import { LedgerAdapter } from "../adapters/ledger";
import { moneroKeys, moneroPublicKeys } from "../adapters/monero-keys";
import { reviewRequest } from "../adapters/review";
import { registerSoftware, signSoftware } from "../adapters/software";
import { thorTypedData } from "../adapters/thor-eip712";
import { TrezorAdapter } from "../adapters/trezor";
import { verifyResult } from "../adapters/verify";

import type { SigningDriver, StateRepository } from "./broker";
import type { Account, UiRequest, UiState } from "@rujira/connect-core";

export class WalletDriver implements SigningDriver {
  readonly sessions = new KeystoreSessions();
  private readonly ledger = new LedgerAdapter();
  private readonly trezor = new TrezorAdapter();
  private busy = false;
  constructor(private readonly repository: StateRepository) {}
  review: SigningDriver["review"] = reviewRequest;

  async state(): Promise<UiState> {
    const state = await this.repository.load();
    return uiStateSchema.parse({
      accounts: state.accounts,
      sources: state.sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        label: source.label,
        ...(source.deviceName ? { deviceName: source.deviceName } : {}),
      })),
      grants: state.grants,
      unlocked: state.sources.flatMap((source) => {
        const expiresAt = this.sessions.unlockedUntil(source.id);
        return expiresAt === undefined
          ? []
          : [{ sourceId: source.id, expiresAt }];
      }),
      ...(this.trezor.prompt ? { devicePrompt: this.trezor.prompt } : {}),
    });
  }

  deviceResponse(
    request: Extract<UiRequest, { action: "deviceResponse" }>
  ): void {
    this.trezor.respond(request);
  }

  async import(
    request: Extract<UiRequest, { action: "import" }>
  ): Promise<void> {
    const id = crypto.randomUUID();
    await this.sessions.unlock(id, request.keystore, request.password);
    await this.repository.update((state) => ({
      ...state,
      sources: [
        ...state.sources,
        {
          id,
          kind: "keystore",
          label: request.label,
          encryptedKeystore: request.keystore,
        },
      ],
    }));
    await chrome.alarms.create(`lock:${id}`, {
      when: this.sessions.unlockedUntil(id) ?? Date.now(),
    });
  }

  async unlock(sourceId: string, password: string): Promise<void> {
    const source = (await this.repository.load()).sources.find(
      (entry) => entry.id === sourceId
    );
    if (!source?.encryptedKeystore)
      throw new ConnectError(
        ERROR_CODES.invalid,
        "Select an imported keystore"
      );
    await this.sessions.unlock(sourceId, source.encryptedKeystore, password);
    await chrome.alarms.create(`lock:${sourceId}`, {
      when: this.sessions.unlockedUntil(sourceId) ?? Date.now(),
    });
  }

  async lock(): Promise<void> {
    this.sessions.lock();
    await this.ledger.disconnect();
    this.trezor.disconnect();
  }

  async register(
    request: Extract<UiRequest, { action: "register" }>
  ): Promise<Account> {
    if (this.busy)
      throw new ConnectError(
        ERROR_CODES.busy,
        "A device request is already in progress"
      );
    this.busy = true;
    try {
      const state = await this.repository.load();
      let source = state.sources.find((entry) => entry.id === request.sourceId);
      if (request.sourceId && source?.kind !== request.source)
        throw new ConnectError(
          ERROR_CODES.invalid,
          "Source does not match the selected wallet"
        );
      source ??= {
        id: crypto.randomUUID(),
        kind: request.source,
        label: request.source === "ledger" ? "Ledger" : "Trezor",
      };
      if (source.kind === "keystore" && !source.encryptedKeystore)
        throw new ConnectError(ERROR_CODES.invalid, "Import a keystore first");
      const scheme =
        request.chain === "THOR" && request.profile === "evm"
          ? "eip712"
          : "native";
      if (
        request.profile === "evm" &&
        (request.chain !== "THOR" || request.source === "keystore")
      )
        throw new ConnectError(
          ERROR_CODES.unsupported,
          "The Ethereum app profile is for THORChain hardware accounts"
        );
      const methods = supportedMethods(request.chain, request.source, scheme);
      if (!methods.length && request.chain !== "XMR")
        throw new ConnectError(
          ERROR_CODES.unsupported,
          "This wallet does not support the selected chain and app profile"
        );
      const base = accountSchema.parse({
        id: crypto.randomUUID(),
        sourceId: source.id,
        source: source.kind,
        chain: request.chain,
        address: "pending",
        path: accountPath(
          request.chain,
          request.accountIndex,
          request.source,
          request.profile
        ),
        label:
          `${source.label} · ${CHAINS[request.chain].name} ${String(request.accountIndex + 1)}`.slice(
            0,
            80
          ),
        scheme,
        verifiedAt: Date.now(),
        methods,
      });
      let account: Account;
      if (source.kind === "keystore") {
        if (request.chain === "XMR") {
          const { address } = moneroKeys(
            this.sessions.seed(source.id),
            base.path
          );
          account = {
            ...base,
            address,
            publicKey: moneroPublicKeys(address).publicKey,
          };
        } else account = registerSoftware(this.sessions.seed(source.id), base);
      } else if (source.kind === "ledger") {
        const registered = await this.ledger.register(
          base,
          source.deviceId,
          state.accounts.filter((entry) => entry.source === "ledger")
        );
        account = registered.account;
        const matched = state.sources.find(
          (entry) => entry.id === registered.matchedSourceId
        );
        source = {
          ...(matched ?? source),
          deviceId: registered.deviceId,
          deviceName: registered.deviceName,
          label: registered.deviceName,
        };
        account = { ...account, sourceId: source.id };
      } else {
        account = await this.trezor.register(base);
        const device = await this.trezor.deviceInfo();
        source = { ...source, ...device, label: device.deviceName };
      }
      const savedSource = source;
      const updated = await this.repository.update((current) => {
        if (
          request.sourceId &&
          !current.sources.some((entry) => entry.id === request.sourceId)
        )
          throw new ConnectError(
            ERROR_CODES.unauthorized,
            "The source was removed during registration"
          );
        return saveRegisteredAccount(
          current,
          savedSource,
          accountSchema.parse(account)
        );
      });
      return (
        updated.accounts.find(
          (entry) =>
            entry.source === account.source &&
            (entry.sourceId === account.sourceId ||
              account.source !== "keystore") &&
            entry.chain === account.chain &&
            entry.address === account.address &&
            entry.scheme === account.scheme
        ) ?? account
      );
    } finally {
      this.busy = false;
    }
  }

  async sign(
    account: Account,
    request: Parameters<SigningDriver["sign"]>[1],
    _digest: string,
    password?: string
  ): Promise<unknown> {
    validateSignAccount(account, request);
    const signed = await this.performSign(account, request, password);
    verifyResult(account, request, signed);
    return signed;
  }

  private async performSign(
    account: Account,
    request: Parameters<SigningDriver["sign"]>[1],
    password?: string
  ): Promise<unknown> {
    if (this.busy)
      throw new ConnectError(
        ERROR_CODES.busy,
        "A device request is already in progress"
      );
    this.busy = true;
    try {
      const source = (await this.repository.load()).sources.find(
        (entry) => entry.id === account.sourceId
      );
      if (!source)
        throw new ConnectError(
          ERROR_CODES.unauthorized,
          "This source was removed"
        );
      if (source.kind === "keystore") {
        if (password) await this.unlock(source.id, password);
        return signSoftware(this.sessions.seed(source.id), account, request);
      }
      if (account.scheme === "eip712" && request.method === "signAmino") {
        const params = thorTypedData(request.params, request.typedData);
        const evmAccount: Account = {
          ...account,
          chain: "ETH",
          address: computeAddress(`0x${account.publicKey ?? ""}`),
          scheme: "native",
          methods: [...supportedMethods("ETH", source.kind)],
        };
        const evmRequest = {
          accountId: account.id,
          chain: "ETH" as const,
          method: "eth_signTypedData_v4" as const,
          params,
        };
        const result =
          source.kind === "ledger"
            ? await this.ledger.sign(evmAccount, evmRequest, source.deviceId)
            : await this.trezor.sign(evmAccount, evmRequest);
        verifyResult(evmAccount, evmRequest, result);
        if (typeof result !== "string")
          throw new ConnectError(
            ERROR_CODES.invalid,
            "Invalid Ethereum app signature"
          );
        return {
          signed: request.params,
          signature: {
            pub_key: {
              type: "os/PubKeyEthSecp256k1",
              value: base64(fromHex(account.publicKey ?? "")),
            },
            signature: base64(fromHex(result)),
          },
        };
      }
      return source.kind === "ledger"
        ? await this.ledger.sign(account, request, source.deviceId)
        : await this.trezor.sign(account, request);
    } finally {
      this.busy = false;
    }
  }
}
