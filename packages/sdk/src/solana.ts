import { ConnectError, ERROR_CODES } from "@rujira/connect-core";
import { registerWallet } from "@wallet-standard/wallet";

import type { RujiraProvider } from "./provider";
import type { PublicAccount } from "@rujira/connect-core";
import type { Wallet, WalletAccount, WalletIcon } from "@wallet-standard/base";

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  );
}
function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
function decode(value: unknown, key: string): Uint8Array {
  if (
    typeof value !== "object" ||
    value === null ||
    !(key in value) ||
    typeof (value as Record<string, unknown>)[key] !== "string"
  )
    throw new ConnectError(
      ERROR_CODES.invalid,
      "Invalid Solana signature response"
    );
  const encoded = (value as Record<string, string>)[key];
  if (!encoded)
    throw new ConnectError(ERROR_CODES.invalid, "Empty Solana response");
  return Uint8Array.from(atob(encoded), (byte) => byte.charCodeAt(0));
}
interface TransactionInput {
  readonly account: WalletAccount;
  readonly chain?: string;
  readonly transaction: Uint8Array;
}
interface MessageInput {
  readonly account: WalletAccount;
  readonly message: Uint8Array;
}

class SolanaWallet implements Wallet {
  readonly version = "1.0.0";
  readonly name = "Rujira Connect";
  readonly chains = ["solana:mainnet"] as const;
  private registered: PublicAccount[] = [];
  private readonly listeners = new Set<
    (properties: { accounts: readonly WalletAccount[] }) => void
  >();
  readonly features;
  constructor(
    private readonly bridge: RujiraProvider,
    readonly icon: WalletIcon
  ) {
    this.features = {
      "standard:connect": {
        version: "1.0.0",
        connect: async (options?: {
          silent?: boolean;
        }): Promise<{ accounts: readonly WalletAccount[] }> => {
          await this.refresh(options?.silent !== true);
          return { accounts: this.accounts };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async (): Promise<void> => {
          await bridge.disconnect();
          await this.refresh(false);
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (
          event: string,
          listener: (properties: { accounts: readonly WalletAccount[] }) => void
        ): (() => void) => {
          if (event !== "change")
            return () => {
              /* This best-effort notification has no user-visible result. */
            };
          this.listeners.add(listener);
          return () => {
            this.listeners.delete(listener);
          };
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (
          ...inputs: TransactionInput[]
        ): Promise<{ signedTransaction: Uint8Array }[]> => {
          const outputs: { signedTransaction: Uint8Array }[] = [];
          for (const input of inputs) {
            if (input.chain !== undefined && input.chain !== "solana:mainnet")
              throw new ConnectError(
                ERROR_CODES.wrongChain,
                "Only Solana mainnet accounts are registered"
              );
            const account = this.account(input.account);
            const result = await bridge.request({
              accountId: account.id,
              chain: "SOL",
              method: "signSolanaTransaction",
              params: { transaction: base64(input.transaction) },
            });
            outputs.push({
              signedTransaction: decode(result.payload, "transaction"),
            });
          }
          return outputs;
        },
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (
          ...inputs: MessageInput[]
        ): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]> => {
          const outputs: {
            signedMessage: Uint8Array;
            signature: Uint8Array;
          }[] = [];
          for (const input of inputs) {
            const account = this.account(input.account);
            const result = await bridge.request({
              accountId: account.id,
              chain: "SOL",
              method: "signSolanaMessage",
              params: {
                message: Array.from(input.message, (byte) =>
                  byte.toString(16).padStart(2, "0")
                ).join(""),
              },
            });
            outputs.push({
              signedMessage: input.message,
              signature: decode(result.payload, "signature"),
            });
          }
          return outputs;
        },
      },
    } as const;
    bridge.on("accountsChanged", () => {
      this.refresh(false).catch(() => {
        /* This best-effort notification has no user-visible result. */
      });
    });
  }
  get accounts(): readonly WalletAccount[] {
    return this.registered.map((account) =>
      Object.freeze({
        address: account.address,
        publicKey: hexBytes(account.publicKey ?? ""),
        chains: this.chains,
        features: ["solana:signTransaction", "solana:signMessage"] as const,
      })
    );
  }
  private account(claimed: WalletAccount): PublicAccount {
    const account = this.registered.find(
      (entry) =>
        entry.address === claimed.address &&
        entry.publicKey ===
          Array.from(claimed.publicKey, (byte) =>
            byte.toString(16).padStart(2, "0")
          ).join("")
    );
    if (!account)
      throw new ConnectError(
        ERROR_CODES.unauthorized,
        "Solana account is not approved"
      );
    return account;
  }
  private async refresh(connect: boolean): Promise<void> {
    this.registered = (
      connect
        ? await this.bridge.connect({ chains: ["SOL"] })
        : await this.bridge.getAccounts()
    ).filter((account) => account.chain === "SOL");
    for (const listener of this.listeners)
      listener({ accounts: this.accounts });
  }
}

export function registerSolanaWallet(
  bridge: RujiraProvider,
  svg: string
): void {
  const icon: WalletIcon = `data:image/svg+xml;base64,${btoa(svg)}`;
  registerWallet(new SolanaWallet(bridge, icon));
}
