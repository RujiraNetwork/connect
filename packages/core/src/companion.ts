import { z } from "zod";

import { MAX_ACCOUNT_INDEX } from "./chains";
import { accountSchema, decimalSchema, signRequestSchema } from "./protocol";

export const COMPANION_NAME = "network.rujira.connect";
export const DEFAULT_MONERO_NODE = "https://xmr-node.cakewallet.com:18081";
export const companionRequestSchema = z.discriminatedUnion("method", [
  z.object({ id: z.string().uuid(), method: z.literal("status") }).strict(),
  z
    .object({
      id: z.string().uuid(),
      method: z.literal("register"),
      source: z.enum(["ledger", "trezor", "keystore"]),
      sourceId: z.string().uuid(),
      accountIndex: z.number().int().min(0).max(MAX_ACCOUNT_INDEX),
      account: accountSchema.optional(),
      restoreHeight: z.number().int().nonnegative(),
      password: z.string().min(1).max(1024),
      spendKey: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      viewKey: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      address: z.string().min(95).max(106).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      method: z.literal("sync"),
      accountId: z.string().uuid(),
      password: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      method: z.literal("sign"),
      account: accountSchema,
      request: signRequestSchema,
      approvalDigest: z.string().regex(/^[a-f0-9]{64}$/),
      password: z.string().min(1).max(1024),
      maxFee: decimalSchema,
    })
    .strict(),
  z.object({ id: z.string().uuid(), method: z.literal("lock") }).strict(),
  z
    .object({
      id: z.string().uuid(),
      method: z.literal("setNode"),
      url: z.string().url(),
    })
    .strict(),
]);
export type CompanionRequest = z.infer<typeof companionRequestSchema>;
