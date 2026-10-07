import {
  CHANNEL,
  CHAINS,
  ConnectError,
  ERROR_CODES,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  publicAccountSchema,
  publicRequestSchema,
  responseSchema,
  signRequestSchema,
  aminoDocSchema,
  capabilitiesSchema,
} from "@rujira/connect-core";

import type {
  Chain,
  Capabilities,
  PublicAccount,
  PublicRequest,
  RpcResponse,
  SignRequest,
  SignResult,
} from "@rujira/connect-core";

export type ProviderEvent =
  "accountsChanged" | "chainChanged" | "disconnect" | "lockChanged";
export interface RujiraProvider {
  readonly version: 1;
  connect(options: {
    readonly chains: readonly Chain[];
  }): Promise<PublicAccount[]>;
  getAccounts(): Promise<PublicAccount[]>;
  getCapabilities(): Promise<Capabilities>;
  request(request: SignRequest): Promise<SignResult>;
  disconnect(): Promise<void>;
  on(event: ProviderEvent, listener: (value: unknown) => void): () => void;
}

export function parseAccounts(value: unknown): PublicAccount[] {
  return publicAccountSchema
    .array()
    .parse(value)
    .map(({ publicKey, ...account }) => ({
      ...account,
      ...(publicKey === undefined ? {} : { publicKey }),
    }));
}

export function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ConnectError(ERROR_CODES.invalid, "Expected an object");
  return value as Record<string, unknown>;
}

export class BrowserRujiraProvider implements RujiraProvider {
  readonly version = PROTOCOL_VERSION;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly listeners = new Map<
    ProviderEvent,
    Set<(value: unknown) => void>
  >();

  constructor(private readonly target: Window) {
    target.addEventListener("message", this.receive);
    target.addEventListener("pagehide", this.dispose);
  }

  async connect(options: {
    readonly chains: readonly Chain[];
  }): Promise<PublicAccount[]> {
    return parseAccounts(
      await this.call({
        method: "connect",
        params: { chains: [...options.chains] },
      })
    );
  }
  async getAccounts(): Promise<PublicAccount[]> {
    return parseAccounts(await this.call({ method: "getAccounts" }));
  }
  async getCapabilities(): Promise<Capabilities> {
    return capabilitiesSchema.parse(
      await this.call({ method: "getCapabilities" })
    );
  }
  async request(request: SignRequest): Promise<SignResult> {
    const validated = signRequestSchema.parse(request);
    const result = objectOf(
      await this.call({ method: "sign", params: validated })
    );
    if (
      result.accountId !== request.accountId ||
      result.chain !== request.chain ||
      result.method !== request.method
    )
      throw new ConnectError(
        ERROR_CODES.invalid,
        "Signing response does not match the request"
      );
    return {
      accountId: request.accountId,
      chain: request.chain,
      method: request.method,
      payload: result.payload,
    };
  }
  async disconnect(): Promise<void> {
    await this.call({ method: "disconnect" });
  }
  on(event: ProviderEvent, listener: (value: unknown) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  private call(request: PublicRequest): Promise<unknown> {
    publicRequestSchema.parse(request);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ConnectError(ERROR_CODES.expired, "The request expired"));
      }, REQUEST_TIMEOUT_MS + 1000);
      this.pending.set(id, { resolve, reject, timer });
      this.target.postMessage(
        {
          channel: CHANNEL,
          version: PROTOCOL_VERSION,
          direction: "request",
          id,
          request,
        },
        this.target.location.origin
      );
    });
  }

  private readonly receive = (event: MessageEvent<unknown>): void => {
    if (
      event.source !== this.target ||
      event.origin !== this.target.location.origin ||
      typeof event.data !== "object" ||
      event.data === null
    )
      return;
    const message = objectOf(event.data);
    if (message.channel !== CHANNEL || message.version !== PROTOCOL_VERSION)
      return;
    if (message.direction === "event") {
      const name = message.event;
      if (
        name === "accountsChanged" ||
        name === "chainChanged" ||
        name === "disconnect" ||
        name === "lockChanged"
      )
        for (const listener of this.listeners.get(name) ?? [])
          listener(message.value);
      return;
    }
    if (message.direction !== "response" || typeof message.id !== "string")
      return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    const parsed = responseSchema.safeParse(message.response);
    if (!parsed.success) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    this.settle(parsed.data, pending);
  };

  private settle(
    response: RpcResponse,
    pending: {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  ): void {
    if (response.ok) pending.resolve(response.result);
    else
      pending.reject(
        new ConnectError(response.error.code, response.error.message)
      );
  }

  private readonly dispose = (): void => {
    this.target.removeEventListener("message", this.receive);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new ConnectError(ERROR_CODES.disconnected, "The page disconnected")
      );
    }
    this.pending.clear();
  };
}

declare global {
  interface Window {
    rujira?: RujiraProvider & {
      readonly ethereum: EvmProvider;
      readonly cosmos: CosmosProvider;
    };
  }
}

export class EvmProvider {
  private chain: Chain = "ETH";
  private readonly listeners = new Map<
    ProviderEvent,
    Set<(value: unknown) => void>
  >();
  constructor(private readonly bridge: RujiraProvider) {
    bridge.on("accountsChanged", (value) => {
      const parsed = publicAccountSchema.array().safeParse(value);
      if (parsed.success)
        this.emit(
          "accountsChanged",
          parsed.data
            .filter((account) => account.chain === this.chain)
            .map((account) => account.address)
        );
    });
    bridge.on("disconnect", (value) => {
      this.emit("disconnect", value);
    });
    bridge.on("lockChanged", (value) => {
      this.emit("lockChanged", value);
    });
  }
  on(event: ProviderEvent, listener: (value: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  removeListener(
    event: ProviderEvent,
    listener: (value: unknown) => void
  ): void {
    this.listeners.get(event)?.delete(listener);
  }
  off(event: ProviderEvent, listener: (value: unknown) => void): void {
    this.removeListener(event, listener);
  }
  private emit(event: ProviderEvent, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
  private setChain(chain: Chain): void {
    if (this.chain === chain) return;
    this.chain = chain;
    this.emit(
      "chainChanged",
      `0x${(CHAINS[chain].evmChainId ?? 1).toString(16)}`
    );
  }
  async request(args: {
    readonly method: string;
    readonly params?: unknown;
  }): Promise<unknown> {
    if (args.method === "eth_chainId")
      return `0x${(CHAINS[this.chain].evmChainId ?? 1).toString(16)}`;
    if (args.method === "net_version")
      return String(CHAINS[this.chain].evmChainId ?? 1);
    if (args.method === "eth_requestAccounts") {
      const accounts = await this.bridge.connect({
        chains: ["ETH", "BSC", "AVAX", "BASE"],
      });
      const first = accounts.find(
        (account) => CHAINS[account.chain].family === "evm"
      );
      if (first) this.setChain(first.chain);
    }
    const accounts = await this.bridge.getAccounts();
    const active = accounts.filter((account) => account.chain === this.chain);
    if (args.method === "eth_accounts" || args.method === "eth_requestAccounts")
      return active.map((account) => account.address);
    const params = Array.isArray(args.params) ? (args.params as unknown[]) : [];
    if (args.method === "wallet_switchEthereumChain") {
      const id = objectOf(params[0]).chainId;
      const next = accounts.find(
        (account) =>
          typeof id === "string" &&
          CHAINS[account.chain].evmChainId === Number(BigInt(id))
      );
      if (!next)
        throw new ConnectError(
          ERROR_CODES.wrongChain,
          "Register and approve an account for this network first"
        );
      this.setChain(next.chain);
      this.emit(
        "accountsChanged",
        accounts
          .filter((account) => account.chain === this.chain)
          .map((account) => account.address)
      );
      return null;
    }
    if (
      args.method !== "eth_signTransaction" &&
      args.method !== "personal_sign" &&
      args.method !== "eth_signTypedData_v4"
    )
      throw new ConnectError(
        ERROR_CODES.unsupported,
        "Rujira Connect supports signing only; prepare and broadcast transactions in the dapp"
      );
    const claimed =
      args.method === "personal_sign"
        ? params[1]
        : args.method === "eth_signTypedData_v4"
          ? params[0]
          : objectOf(params[0]).from;
    const account = active.find(
      (entry) =>
        typeof claimed === "string" &&
        entry.address.toLowerCase() === claimed.toLowerCase()
    );
    if (!account)
      throw new ConnectError(
        ERROR_CODES.unauthorized,
        "The account is not approved for this network"
      );
    let nativeParams: unknown;
    if (args.method === "personal_sign") nativeParams = { message: params[0] };
    else if (args.method === "eth_signTypedData_v4")
      nativeParams =
        typeof params[1] === "string"
          ? (JSON.parse(params[1]) as unknown)
          : params[1];
    else {
      const transaction = objectOf(params[0]);
      const nonce = transaction.nonce;
      nativeParams = {
        ...transaction,
        nonce: typeof nonce === "string" ? Number(BigInt(nonce)) : nonce,
        gasLimit: transaction.gas ?? transaction.gasLimit,
      };
      delete objectOf(nativeParams).gas;
    }
    const result = await this.bridge.request(
      signRequestSchema.parse({
        accountId: account.id,
        chain: account.chain,
        method: args.method,
        params: nativeParams,
      })
    );
    return result.payload;
  }
}

export interface CosmosAccount {
  readonly address: string;
  readonly algo: "secp256k1";
  readonly pubkey: Uint8Array;
}
export interface DirectSignDoc {
  readonly bodyBytes: Uint8Array;
  readonly authInfoBytes: Uint8Array;
  readonly chainId: string;
  readonly accountNumber: bigint;
}
export interface CosmosSignResponse<T> {
  readonly signed: T;
  readonly signature: {
    readonly pub_key: { readonly type: string; readonly value: string };
    readonly signature: string;
  };
}
export interface CosmosOfflineSigner {
  getAccounts(): Promise<CosmosAccount[]>;
  signAmino(
    address: string,
    signDoc: unknown,
    options?: { readonly typedData: unknown }
  ): Promise<CosmosSignResponse<unknown>>;
  signDirect(
    address: string,
    signDoc: DirectSignDoc
  ): Promise<CosmosSignResponse<DirectSignDoc>>;
}
function byteHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}
function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (value) =>
    Number.parseInt(value, 16)
  );
}
function nativeSignature(
  value: unknown
): CosmosSignResponse<unknown>["signature"] {
  const response = objectOf(value);
  const signature = objectOf(response.signature);
  const pubkey = objectOf(signature.pub_key);
  if (
    typeof signature.signature !== "string" ||
    typeof pubkey.type !== "string" ||
    typeof pubkey.value !== "string"
  )
    throw new ConnectError(
      ERROR_CODES.invalid,
      "Invalid Cosmos signature response"
    );
  return {
    pub_key: { type: pubkey.type, value: pubkey.value },
    signature: signature.signature,
  };
}
export class CosmosProvider {
  constructor(private readonly bridge: RujiraProvider) {}
  async enable(chainId: string): Promise<void> {
    await this.bridge.connect({ chains: [this.chainOf(chainId)] });
  }
  getOfflineSigner(chainId: string): CosmosOfflineSigner {
    const chain = this.chainOf(chainId);
    const sign = async (
      method: "signAmino" | "signDirect",
      address: string,
      params: unknown,
      prepared?: unknown
    ): Promise<unknown> => {
      const account = (await this.bridge.getAccounts()).find(
        (entry) => entry.chain === chain && entry.address === address
      );
      if (!account)
        throw new ConnectError(
          ERROR_CODES.unauthorized,
          "Cosmos account is not approved"
        );
      return (
        await this.bridge.request(
          signRequestSchema.parse({
            accountId: account.id,
            chain,
            method,
            params,
            ...(prepared === undefined ? {} : { typedData: prepared }),
          })
        )
      ).payload;
    };
    return {
      getAccounts: async () =>
        (await this.bridge.getAccounts())
          .filter((account) => account.chain === chain)
          .map((account) => ({
            address: account.address,
            algo: "secp256k1",
            pubkey: hexBytes(account.publicKey ?? ""),
          })),
      signAmino: async (address, params, options) => {
        const doc = aminoDocSchema.parse(params);
        const result = await sign(
          "signAmino",
          address,
          doc,
          options?.typedData
        );
        return {
          signed: objectOf(result).signed,
          signature: nativeSignature(result),
        };
      },
      signDirect: async (address, doc) => {
        const result = await sign("signDirect", address, {
          bodyBytes: byteHex(doc.bodyBytes),
          authInfoBytes: byteHex(doc.authInfoBytes),
          chainId: doc.chainId,
          accountNumber: doc.accountNumber.toString(),
        });
        return { signed: doc, signature: nativeSignature(result) };
      },
    };
  }
  getOfflineSignerOnlyAmino(
    chainId: string
  ): Pick<CosmosOfflineSigner, "getAccounts" | "signAmino"> {
    const signer = this.getOfflineSigner(chainId);
    return {
      getAccounts: () => signer.getAccounts(),
      signAmino: (address, doc, options) =>
        signer.signAmino(address, doc, options),
    };
  }
  async getOfflineSignerAuto(
    chainId: string
  ): Promise<
    CosmosOfflineSigner | Pick<CosmosOfflineSigner, "getAccounts" | "signAmino">
  > {
    const accounts = (await this.bridge.getAccounts()).filter(
      (account) => account.chain === this.chainOf(chainId)
    );
    return accounts.every((account) => account.methods.includes("signDirect"))
      ? this.getOfflineSigner(chainId)
      : this.getOfflineSignerOnlyAmino(chainId);
  }
  private chainOf(chainId: string): Chain {
    if (chainId === "thorchain-1") return "THOR";
    if (chainId === "cosmoshub-4") return "GAIA";
    throw new ConnectError(
      ERROR_CODES.unsupported,
      "This Cosmos chain is not supported"
    );
  }
}
