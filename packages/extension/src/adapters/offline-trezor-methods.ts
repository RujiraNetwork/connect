import * as ethereum from "@trezor/connect-core/lib/api/ethereum/api/index.js";
import getAddress from "@trezor/connect-core/lib/api/getAddress.js";
import getFeatures from "@trezor/connect-core/lib/api/getFeatures.js";
import getPublicKey from "@trezor/connect-core/lib/api/getPublicKey.js";
import * as monero from "@trezor/connect-core/lib/api/monero/api/index.js";
import * as ripple from "@trezor/connect-core/lib/api/ripple/api/index.js";
import signMessage from "@trezor/connect-core/lib/api/signMessage.js";
import signTransaction from "@trezor/connect-core/lib/api/signTransaction.js";
import * as solana from "@trezor/connect-core/lib/api/solana/api/index.js";
import * as tron from "@trezor/connect-core/lib/api/tron/api/index.js";
import { ERRORS } from "@trezor/connect-core/lib/exports.js";
import { z } from "zod";

// Chrome extension service workers cannot use import(). Keep the vendor's native
// method implementations, but load supported chains statically at build time.
const METHODS = {
  getAddress,
  getFeatures,
  getPublicKey,
  signMessage,
  signTransaction,
  ...ethereum,
  ...monero,
  ...ripple,
  ...solana,
  ...tron,
};
type Method = InstanceType<(typeof METHODS)[keyof typeof METHODS]>;
type MethodConstructor = new (message: unknown) => Method;
const methodSchema = z.object({ payload: z.object({ method: z.string() }) });

export function getMethod(message: unknown): Promise<Method> {
  const parsed = methodSchema.safeParse(message);
  if (!parsed.success || !Object.hasOwn(METHODS, parsed.data.payload.method))
    throw ERRORS.TypedError(
      "Method_InvalidParameter",
      "Unsupported offline Trezor method"
    );
  // Vendor constructors narrow their message to a single method; their own
  // dispatcher uses this same runtime registry and validates each payload.
  const Constructor = METHODS[
    parsed.data.payload.method as keyof typeof METHODS
  ] as unknown as MethodConstructor;
  return Promise.resolve(new Constructor(message));
}
