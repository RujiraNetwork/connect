import { canonicalJson, ConnectError, ERROR_CODES } from "@rujira/connect-core";
import { z } from "zod";

import { typedData, validateTypedFields } from "./transactions";

import type { AminoSignDoc, SignRequest } from "@rujira/connect-core";

const schema = z
  .object({
    domain: z.record(z.unknown()),
    primaryType: z.string(),
    types: z.record(
      z.array(z.object({ name: z.string(), type: z.string() }).strict())
    ),
    message: z.record(z.unknown()),
  })
  .strict();
type ThorTypedData = z.infer<typeof schema>;

/** App-prepared typed data must include every approved Amino value. */
export function validateThorTypedData(
  doc: AminoSignDoc,
  value: unknown
): ThorTypedData {
  const data = schema.parse(value);
  const numbered = Object.fromEntries(
    doc.msgs.map((message, index) => [`msg${String(index)}`, message])
  );
  const header = Object.fromEntries(
    Object.entries(doc).filter(([key]) => key !== "msgs")
  );
  const expected = { ...header, ...numbered };
  if (
    canonicalJson(data.message) !== canonicalJson(expected) &&
    canonicalJson(data.message) !== canonicalJson(doc)
  )
    throw new ConnectError(
      ERROR_CODES.invalid,
      "THORChain typed data changed the approved Amino document"
    );
  if (data.message.chain_id !== "thorchain-1")
    throw new ConnectError(
      ERROR_CODES.wrongChain,
      "THORChain typed data targets another network"
    );
  validateTypedFields(data.primaryType, data.message, data.types);
  typedData(data);
  return data;
}

export function thorTypedData(
  doc: AminoSignDoc,
  prepared: unknown
): Extract<SignRequest, { method: "eth_signTypedData_v4" }>["params"] {
  if (prepared === undefined)
    throw new ConnectError(
      ERROR_CODES.invalid,
      "This THORChain account uses the Ethereum app. The app must include prepared EIP-712 data with its signing request."
    );
  const data = validateThorTypedData(doc, prepared);
  if (
    data.primaryType !== "Tx" ||
    data.domain.name !== "Cosmos Web3" ||
    data.domain.version !== "1.0.0" ||
    data.domain.verifyingContract !== "cosmos" ||
    data.domain.salt !== "0" ||
    ![1, "1", "0x1"].includes(data.domain.chainId as string | number)
  )
    throw new ConnectError(
      ERROR_CODES.invalid,
      "The THORChain request uses an unexpected EIP-712 domain."
    );
  return data;
}
