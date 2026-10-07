import { ConnectError, ERROR_CODES } from "./errors";

export const CHAIN_IDS = [
  "THOR",
  "BTC",
  "BCH",
  "LTC",
  "DOGE",
  "ETH",
  "BSC",
  "AVAX",
  "BASE",
  "GAIA",
  "XRP",
  "TRON",
  "SOL",
  "XMR",
] as const;
export type Chain = (typeof CHAIN_IDS)[number];
export type SourceKind = "ledger" | "trezor" | "keystore";
export type SigningMethod =
  | "eth_signTransaction"
  | "personal_sign"
  | "eth_signTypedData_v4"
  | "signAmino"
  | "signDirect"
  | "signPsbt"
  | "signUtxoTransaction"
  | "signSolanaTransaction"
  | "signSolanaMessage"
  | "signXrpTransaction"
  | "signTronTransaction"
  | "signMoneroTransfer";

export interface ChainDefinition {
  readonly id: Chain;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly family:
    "evm" | "cosmos" | "utxo" | "solana" | "xrp" | "tron" | "monero";
  readonly path: string;
  readonly nativeChainId?: string;
  readonly evmChainId?: number;
  readonly app: string;
  readonly methods: readonly SigningMethod[];
}

const evmMethods = [
  "eth_signTransaction",
  "personal_sign",
  "eth_signTypedData_v4",
] as const;
export const CHAINS: Readonly<Record<Chain, ChainDefinition>> = {
  THOR: {
    id: "THOR",
    name: "THORChain",
    symbol: "RUNE",
    decimals: 8,
    family: "cosmos",
    path: "m/44'/931'/0'/0/0",
    nativeChainId: "thorchain-1",
    app: "THORChain",
    methods: ["signAmino", "signDirect"],
  },
  BTC: {
    id: "BTC",
    name: "Bitcoin",
    symbol: "BTC",
    decimals: 8,
    family: "utxo",
    path: "m/84'/0'/0'/0/0",
    app: "Bitcoin",
    methods: ["signPsbt", "signUtxoTransaction"],
  },
  BCH: {
    id: "BCH",
    name: "Bitcoin Cash",
    symbol: "BCH",
    decimals: 8,
    family: "utxo",
    path: "m/44'/145'/0'/0/0",
    app: "Bitcoin Cash",
    methods: ["signUtxoTransaction"],
  },
  LTC: {
    id: "LTC",
    name: "Litecoin",
    symbol: "LTC",
    decimals: 8,
    family: "utxo",
    path: "m/84'/2'/0'/0/0",
    app: "Litecoin",
    methods: ["signPsbt", "signUtxoTransaction"],
  },
  DOGE: {
    id: "DOGE",
    name: "Dogecoin",
    symbol: "DOGE",
    decimals: 8,
    family: "utxo",
    path: "m/44'/3'/0'/0/0",
    app: "Dogecoin",
    methods: ["signUtxoTransaction"],
  },
  ETH: {
    id: "ETH",
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    family: "evm",
    path: "m/44'/60'/0'/0/0",
    evmChainId: 1,
    app: "Ethereum",
    methods: evmMethods,
  },
  BSC: {
    id: "BSC",
    name: "BNB Smart Chain",
    symbol: "BNB",
    decimals: 18,
    family: "evm",
    path: "m/44'/60'/0'/0/0",
    evmChainId: 56,
    app: "Ethereum",
    methods: evmMethods,
  },
  AVAX: {
    id: "AVAX",
    name: "Avalanche C-Chain",
    symbol: "AVAX",
    decimals: 18,
    family: "evm",
    path: "m/44'/60'/0'/0/0",
    evmChainId: 43114,
    app: "Ethereum",
    methods: evmMethods,
  },
  BASE: {
    id: "BASE",
    name: "Base",
    symbol: "ETH",
    decimals: 18,
    family: "evm",
    path: "m/44'/60'/0'/0/0",
    evmChainId: 8453,
    app: "Ethereum",
    methods: evmMethods,
  },
  GAIA: {
    id: "GAIA",
    name: "Cosmos Hub",
    symbol: "ATOM",
    decimals: 6,
    family: "cosmos",
    path: "m/44'/118'/0'/0/0",
    nativeChainId: "cosmoshub-4",
    app: "Cosmos",
    methods: ["signAmino", "signDirect"],
  },
  XRP: {
    id: "XRP",
    name: "XRP Ledger",
    symbol: "XRP",
    decimals: 6,
    family: "xrp",
    path: "m/44'/144'/0'/0/0",
    app: "XRP",
    methods: ["signXrpTransaction"],
  },
  TRON: {
    id: "TRON",
    name: "TRON",
    symbol: "TRX",
    decimals: 6,
    family: "tron",
    path: "m/44'/195'/0'/0/0",
    app: "Tron",
    methods: ["signTronTransaction"],
  },
  SOL: {
    id: "SOL",
    name: "Solana",
    symbol: "SOL",
    decimals: 9,
    family: "solana",
    path: "m/44'/501'/0'/0'",
    app: "Solana",
    methods: ["signSolanaTransaction", "signSolanaMessage"],
  },
  XMR: {
    id: "XMR",
    name: "Monero",
    symbol: "XMR",
    decimals: 12,
    family: "monero",
    path: "m/44'/128'/0'",
    app: "Monero",
    methods: ["signMoneroTransfer"],
  },
};

export const MAX_ACCOUNT_INDEX = 0x7fffffff;

export function accountIndexLimit(chain: Chain, source: SourceKind): number {
  // Ledger's Bitcoin default wallets cap the BIP44 account at 100.
  // https://github.com/LedgerHQ/app-bitcoin/blob/develop/doc/wallet.md#default-wallets
  if (source === "ledger" && chain === "XMR") return 0;
  return chain === "BTC" && source === "ledger" ? 100 : MAX_ACCOUNT_INDEX;
}

export function accountIndexError(
  chain: Chain,
  source: SourceKind,
  index: number
): string | undefined {
  const maximum = accountIndexLimit(chain, source);
  if (!Number.isSafeInteger(index) || index < 0 || index > maximum)
    if (source === "ledger" && chain === "XMR")
      return "Monero uses the wallet selected in the Ledger app. Use index 0 in Connect.";
    else
      return chain === "BTC" && source === "ledger"
        ? "Choose a whole account index from 0 to 100 for Bitcoin on Ledger."
        : `Choose a whole account index from 0 to ${String(maximum)}.`;
  return undefined;
}

export function accountPath(
  chain: Chain,
  index: number,
  source: SourceKind,
  profile: "default" | "legacy" | "evm" = "default"
): string {
  const error = accountIndexError(chain, source, index);
  if (error) throw new ConnectError(ERROR_CODES.invalid, error);
  if (chain === "THOR" && profile === "evm")
    return `m/44'/60'/${String(index)}'/0/0`;
  if (chain === "XMR" && source === "ledger") return "device";
  const segments = CHAINS[chain].path.split("/");
  segments[3] = `${String(index)}'`;
  const path = segments.join("/");
  if (profile === "legacy" && (chain === "BTC" || chain === "LTC"))
    return path.replace("m/84'", "m/44'");
  return path;
}

export function isDefaultAccountPath(account: {
  readonly chain: Chain;
  readonly source: SourceKind;
  readonly path: string;
}): boolean {
  return account.path === accountPath(account.chain, 0, account.source);
}

export function validateLedgerAccountPath(account: {
  readonly chain: Chain;
  readonly path: string;
  readonly scheme: "native" | "eip712";
}): void {
  if (account.chain === "XMR" && account.path === "device") return;
  const index = Number(account.path.split("/")[3]?.replace(/'$/, ""));
  const profile =
    account.scheme === "eip712"
      ? "evm"
      : (account.chain === "BTC" || account.chain === "LTC") &&
          account.path.startsWith("m/44'")
        ? "legacy"
        : "default";
  const expected = accountPath(account.chain, index, "ledger", profile);
  if (account.path !== expected)
    throw new ConnectError(
      ERROR_CODES.invalid,
      `This ${CHAINS[account.chain].name} account uses an unsupported Ledger path. Add it again with a supported address type.`
    );
}

export function supportedMethods(
  chain: Chain,
  source: SourceKind,
  scheme: "native" | "eip712" = "native"
): readonly SigningMethod[] {
  if (scheme === "eip712" && chain === "THOR") return ["signAmino"];
  if (source === "trezor" && (chain === "THOR" || chain === "GAIA")) return [];
  if (source === "ledger" && CHAINS[chain].family === "cosmos")
    return ["signAmino"];
  if (source === "ledger" && chain === "LTC") return ["signUtxoTransaction"];
  return CHAINS[chain].methods;
}
