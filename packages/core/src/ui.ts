import { z } from "zod";

import { accountIndexError, MAX_ACCOUNT_INDEX } from "./chains";
import {
  accountSchema,
  grantSchema,
  sourceSchema,
  chainSchema,
  jsonObjectSchema,
  publicRequestSchema,
  sourceKindSchema,
} from "./protocol";

export const devicePromptSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["pin", "passphrase", "pairing", "confirmation"]),
    message: z.string(),
  })
  .strict();
export type DevicePrompt = z.infer<typeof devicePromptSchema>;

export const siteActivationSchema = z
  .object({ origin: z.string().url().nullable() })
  .strict();

export const uiStateSchema = z
  .object({
    accounts: z.array(accountSchema),
    sources: z.array(
      sourceSchema.omit({ encryptedKeystore: true, deviceId: true })
    ),
    grants: z.array(grantSchema),
    unlocked: z.array(
      z.object({ sourceId: z.string().uuid(), expiresAt: z.number() })
    ),
    devicePrompt: devicePromptSchema.optional(),
  })
  .strict();
export type UiState = z.infer<typeof uiStateSchema>;

export const uiRequestSchema = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("state") }).strict(),
    z
      .object({
        action: z.literal("activateSite"),
        windowId: z.number().int().nonnegative(),
      })
      .strict(),
    z.object({ action: z.literal("pending"), id: z.string().uuid() }).strict(),
    z
      .object({
        action: z.literal("approve"),
        id: z.string().uuid(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        accountIds: z.array(z.string().uuid()),
        acknowledgeRaw: z.boolean(),
        password: z.string().max(1024).optional(),
      })
      .strict(),
    z.object({ action: z.literal("reject"), id: z.string().uuid() }).strict(),
    z
      .object({
        action: z.literal("register"),
        sourceId: z.string().uuid().optional(),
        source: sourceKindSchema,
        chain: chainSchema,
        accountIndex: z.number().int().min(0).max(MAX_ACCOUNT_INDEX),
        profile: z.enum(["default", "legacy", "evm"]),
      })
      .strict(),
    z
      .object({
        action: z.literal("import"),
        label: z.string().min(1).max(80),
        keystore: jsonObjectSchema,
        password: z.string().min(1).max(1024),
      })
      .strict(),
    z
      .object({
        action: z.literal("unlock"),
        sourceId: z.string().uuid(),
        password: z.string().min(1).max(1024),
      })
      .strict(),
    z.object({ action: z.literal("lock") }).strict(),
    z
      .object({ action: z.literal("forget"), sourceId: z.string().uuid() })
      .strict(),
    z
      .object({
        action: z.literal("removeAccount"),
        accountId: z.string().uuid(),
      })
      .strict(),
    z
      .object({ action: z.literal("revoke"), origin: z.string().url() })
      .strict(),
    z.object({ action: z.literal("deviceGranted") }).strict(),
    z
      .object({
        action: z.literal("deviceResponse"),
        id: z.string(),
        value: z.string().max(1024),
        onDevice: z.boolean(),
        cancel: z.boolean(),
      })
      .strict(),
  ])
  .superRefine((request, context) => {
    if (request.action !== "register") return;
    const message = accountIndexError(
      request.chain,
      request.source,
      request.accountIndex
    );
    if (message)
      context.addIssue({ code: "custom", path: ["accountIndex"], message });
  });
export type UiRequest = z.infer<typeof uiRequestSchema>;

export const pendingViewSchema = z.object({
  id: z.string().uuid(),
  origin: z.string().url(),
  request: publicRequestSchema,
  digest: z.string(),
  expiresAt: z.number(),
  accounts: z.array(
    z.object({
      id: z.string(),
      chain: chainSchema,
      address: z.string(),
      label: z.string(),
      source: sourceKindSchema,
      scheme: z.enum(["native", "eip712"]),
      path: accountSchema.shape.path,
    })
  ),
  review: z
    .object({
      title: z.string(),
      fields: z.array(z.object({ label: z.string(), value: z.string() })),
      raw: z.string(),
      requiresRawAcknowledgement: z.boolean(),
    })
    .optional(),
});
export type PendingView = z.infer<typeof pendingViewSchema>;
