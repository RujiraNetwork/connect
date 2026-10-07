import { z } from "zod";

import { CHAIN_IDS } from "./chains";
import { preparedMoneroTransactionSchema } from "./monero";

export const PROTOCOL_VERSION = 1;
export const CHANNEL = "rujira-connect-v1";
export const UNLOCK_DURATION_MS = 5 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export const chainSchema = z.enum(CHAIN_IDS);
export const sourceKindSchema = z.enum(["ledger", "trezor", "keystore"]);
export const decimalSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(80);
export const hexSchema = z
  .string()
  .regex(/^(?:0x)?(?:[a-fA-F0-9]{2})*$/)
  .max(MAX_MESSAGE_BYTES);
export const quantitySchema = z
  .string()
  .regex(/^(?:0x[\da-fA-F]+|0|[1-9]\d*)$/)
  .max(80);
export const jsonObjectSchema = z.record(z.unknown());

export const accountSchema = z
  .object({
    id: z.string().uuid(),
    sourceId: z.string().uuid(),
    source: sourceKindSchema,
    chain: chainSchema,
    address: z.string().min(1).max(256),
    publicKey: hexSchema.optional(),
    // Ledger Monero's selected wallet is device-managed, with no path in its APDU.
    path: z.string().regex(/^(?:m(?:\/\d+'?){3,5}|device)$/),
    label: z.string().min(1).max(80),
    scheme: z.enum(["native", "eip712"]),
    verifiedAt: z.number().nonnegative(),
    methods: z.array(
      z.enum([
        "eth_signTransaction",
        "personal_sign",
        "eth_signTypedData_v4",
        "signAmino",
        "signDirect",
        "signPsbt",
        "signUtxoTransaction",
        "signSolanaTransaction",
        "signSolanaMessage",
        "signXrpTransaction",
        "signTronTransaction",
        "signMoneroTransaction",
      ])
    ),
  })
  .strict();
export type Account = z.infer<typeof accountSchema>;
export const publicAccountSchema = accountSchema.pick({
  id: true,
  chain: true,
  address: true,
  publicKey: true,
  source: true,
  scheme: true,
  methods: true,
});
export const capabilitiesSchema = z
  .object({
    version: z.literal(1),
    signingOnly: z.literal(true),
    accounts: z.array(
      z
        .object({
          accountId: z.string().uuid(),
          chain: chainSchema,
          source: sourceKindSchema,
          scheme: accountSchema.shape.scheme,
          methods: accountSchema.shape.methods,
        })
        .strict()
    ),
  })
  .strict();
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export const sourceSchema = z
  .object({
    id: z.string().uuid(),
    kind: sourceKindSchema,
    label: z.string().max(80),
    encryptedKeystore: jsonObjectSchema.optional(),
    deviceId: z.string().max(256).optional(),
    deviceName: z.string().max(80).optional(),
  })
  .strict();
export type WalletSource = z.infer<typeof sourceSchema>;

export const grantSchema = z
  .object({
    origin: z.string().url(),
    accountIds: z.array(z.string().uuid()),
    createdAt: z.number(),
  })
  .strict();
export type Grant = z.infer<typeof grantSchema>;
export const stateSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    sources: z.array(sourceSchema),
    accounts: z.array(accountSchema),
    grants: z.array(grantSchema),
  })
  .strict();
export type StoredState = z.infer<typeof stateSchema>;
export const EMPTY_STATE: StoredState = {
  version: PROTOCOL_VERSION,
  sources: [],
  accounts: [],
  grants: [],
};

const evmTransactionSchema = z
  .object({
    chainId: quantitySchema,
    nonce: z.number().int().min(0),
    gasLimit: quantitySchema,
    to: z
      .string()
      .regex(/^0x[\da-fA-F]{40}$/)
      .optional(),
    from: z
      .string()
      .regex(/^0x[\da-fA-F]{40}$/)
      .optional(),
    value: quantitySchema.optional(),
    data: hexSchema.optional(),
    gasPrice: quantitySchema.optional(),
    maxFeePerGas: quantitySchema.optional(),
    maxPriorityFeePerGas: quantitySchema.optional(),
    type: z.number().int().min(0).max(2).optional(),
    accessList: z
      .array(z.object({ address: z.string(), storageKeys: z.array(hexSchema) }))
      .optional(),
  })
  .strict()
  .refine(
    (tx) => tx.gasPrice !== undefined || tx.maxFeePerGas !== undefined,
    "Prepared transactions require a gas price or maximum fee"
  );
export type EvmTransaction = z.infer<typeof evmTransactionSchema>;

export const aminoDocSchema = z
  .object({
    chain_id: z.string().max(128),
    account_number: decimalSchema,
    sequence: decimalSchema,
    fee: z
      .object({
        amount: z
          .array(
            z
              .object({ denom: z.string().max(128), amount: decimalSchema })
              .strict()
          )
          .max(16),
        gas: decimalSchema,
        payer: z.string().optional(),
        granter: z.string().optional(),
      })
      .strict(),
    msgs: z
      .array(
        z
          .object({ type: z.string().max(256), value: jsonObjectSchema })
          .strict()
      )
      .min(1)
      .max(100),
    memo: z.string().max(2048),
  })
  .strict();
export type AminoSignDoc = z.infer<typeof aminoDocSchema>;

export const typedDataSchema = z
  .object({
    domain: jsonObjectSchema,
    types: z.record(
      z.array(z.object({ name: z.string(), type: z.string() }).strict())
    ),
    primaryType: z.string().optional(),
    message: jsonObjectSchema,
  })
  .strict();

const base = { accountId: z.string().uuid(), chain: chainSchema };
export const signRequestSchema = z.discriminatedUnion("method", [
  z
    .object({
      ...base,
      method: z.literal("eth_signTransaction"),
      params: evmTransactionSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("personal_sign"),
      params: z.object({ message: hexSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("eth_signTypedData_v4"),
      params: typedDataSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("signAmino"),
      params: aminoDocSchema,
      typedData: typedDataSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("signDirect"),
      params: z
        .object({
          bodyBytes: hexSchema,
          authInfoBytes: hexSchema,
          chainId: z.string().max(128),
          accountNumber: decimalSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("signPsbt"),
      params: z
        .object({
          psbt: z.string().min(1).max(MAX_MESSAGE_BYTES),
          inputs: z.array(z.number().int().nonnegative()).min(1).max(500),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("signUtxoTransaction"),
      params: z
        .object({
          transactionHex: hexSchema,
          inputs: z
            .array(
              z
                .object({
                  index: z.number().int().nonnegative(),
                  previousTransactionHex: hexSchema,
                  value: decimalSchema,
                })
                .strict()
            )
            .min(1)
            .max(500),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("signSolanaTransaction"),
      params: z
        .object({ transaction: z.string().min(1).max(MAX_MESSAGE_BYTES) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("signSolanaMessage"),
      params: z.object({ message: hexSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("signXrpTransaction"),
      params: jsonObjectSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("signTronTransaction"),
      params: jsonObjectSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("signMoneroTransaction"),
      params: preparedMoneroTransactionSchema,
    })
    .strict(),
]);
export type SignRequest = z.infer<typeof signRequestSchema>;

export const publicRequestSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("connect"),
      params: z
        .object({ chains: z.array(chainSchema).min(1).max(CHAIN_IDS.length) })
        .strict(),
    })
    .strict(),
  z.object({ method: z.literal("getAccounts") }).strict(),
  z.object({ method: z.literal("getCapabilities") }).strict(),
  z.object({ method: z.literal("disconnect") }).strict(),
  z.object({ method: z.literal("sign"), params: signRequestSchema }).strict(),
]);
export type PublicRequest = z.infer<typeof publicRequestSchema>;

export const pageMessageSchema = z
  .object({
    channel: z.literal(CHANNEL),
    version: z.literal(PROTOCOL_VERSION),
    id: z.string().uuid(),
    direction: z.literal("request"),
    request: publicRequestSchema,
  })
  .strict();
export type PageMessage = z.infer<typeof pageMessageSchema>;
export const errorSchema = z
  .object({ code: z.number().int(), message: z.string().max(1024) })
  .strict();
export type SerializedError = z.infer<typeof errorSchema>;
export const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: errorSchema }).strict(),
]);
export type RpcResponse = z.infer<typeof responseSchema>;

export interface SignResult {
  readonly accountId: string;
  readonly chain: Account["chain"];
  readonly method: SignRequest["method"];
  readonly payload: unknown;
}

export interface PublicAccount {
  readonly id: string;
  readonly chain: Account["chain"];
  readonly address: string;
  readonly publicKey?: string;
  readonly source: Account["source"];
  readonly scheme: Account["scheme"];
  readonly methods: Account["methods"];
}

export function publicAccount(account: Account): PublicAccount {
  return {
    id: account.id,
    chain: account.chain,
    address: account.address,
    source: account.source,
    scheme: account.scheme,
    methods: [...account.methods],
    ...(account.publicKey === undefined
      ? {}
      : { publicKey: account.publicKey }),
  };
}
