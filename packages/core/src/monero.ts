import { z } from "zod";

const key = z.string().regex(/^[a-f0-9]{64}$/);
const index = z.number().int().min(0).max(0x7fffffff);
// Trezor's protobuf API accepts JS numbers. Reject values it cannot encode exactly.
const amount = z.number().int().safe().nonnegative();
const destination = z
  .object({
    amount,
    addr: z.object({ spend_public_key: key, view_public_key: key }).strict(),
    is_subaddress: z.literal(false),
    is_integrated: z.literal(false),
    original: z.string().length(95),
  })
  .strict();
const source = z
  .object({
    outputs: z
      .array(
        z
          .object({
            idx: amount,
            key: z.object({ dest: key, commitment: key }).strict(),
          })
          .strict()
      )
      .length(16),
    real_output: z.number().int().min(0).max(15),
    real_out_tx_key: key,
    real_out_additional_tx_keys: z.array(key).max(256),
    real_output_in_tx_index: index,
    amount: amount.positive(),
    rct: z.literal(true),
    mask: key,
    subaddr_minor: index,
  })
  .strict();

/** Offline Monero construction data shared by the supported signers. */
export const preparedMoneroTransactionSchema = z
  .object({
    format: z.enum(["monero-prepared-v1", "trezor-monero-v1"]),
    networkType: z.literal(0),
    inputs: z.array(source).min(1).max(32),
    // In input order, obtained by the dapp from its watch-only wallet/key-image data.
    keyImages: z.array(key).min(1).max(32),
    tsx_data: z
      .object({
        version: z.literal(1),
        client_version: z.literal(3),
        hard_fork: z.literal(16),
        unlock_time: z.literal(0),
        outputs: z.array(destination).length(2),
        change_dts: destination,
        num_inputs: z.number().int().min(1).max(32),
        mixin: z.literal(15),
        fee: amount,
        // Monero account zero inside the registered hardened wallet path.
        account: z.literal(0),
        minor_indices: z.array(index).min(1).max(256),
        integrated_indices: z.array(z.never()).length(0),
        rsig_data: z
          .object({
            rsig_type: z.literal(3),
            bp_version: z.literal(4),
            grouping: z.tuple([z.literal(2)]),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type PreparedMoneroTransaction = z.infer<
  typeof preparedMoneroTransactionSchema
>;

export const signedMoneroTransactionSchema = z
  .object({
    transactionHex: z
      .string()
      .regex(/^(?:[a-f0-9]{2})+$/)
      .max(1024 * 1024),
    transactionHash: key,
    fee: z.string().regex(/^(0|[1-9]\d*)$/),
    amount: z.string().regex(/^(0|[1-9]\d*)$/),
  })
  .strict();

export type SignedMoneroTransaction = z.infer<
  typeof signedMoneroTransactionSchema
>;
