import { ConnectError, ERROR_CODES } from "@rujira/connect-core";

/** Trezor's address/signing methods use device commands; its blockchain backends are excluded. */
function unavailable(): never {
  throw new ConnectError(
    ERROR_CODES.unsupported,
    "The app must prepare the transaction. Connect has no network client."
  );
}
export const BlockbookWorker = unavailable;
export const BlockfrostWorker = unavailable;
export const RippleWorker = unavailable;
export const StellarWorker = unavailable;
export const SolanaWorker = unavailable;
export const EvmRpcWorker = unavailable;
export const ElectrumWorker = undefined;
