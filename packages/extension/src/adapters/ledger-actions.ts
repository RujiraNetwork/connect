import { DeviceActionStatus } from "@ledgerhq/device-management-kit";
import { ConnectError, ERROR_CODES } from "@rujira/connect-core";
import { firstValueFrom, filter, map, timeout, TimeoutError } from "rxjs";

import type { ExecuteDeviceActionReturnType } from "@ledgerhq/device-management-kit";

/** Status meanings specific to the Ledger Monero app, not other chain apps. */
export function moneroLedgerError(status: number): ConnectError {
  switch (status) {
    case 0x6910:
    case 0x69ee:
      return new ConnectError(
        ERROR_CODES.locked,
        "Unlock your Ledger, close and reopen its Monero app, then try again."
      );
    case 0x6982:
      return new ConnectError(
        ERROR_CODES.rejected,
        "The Monero request was declined on your Ledger. Try again and confirm the address on the device."
      );
    case 0x6983:
      return new ConnectError(
        ERROR_CODES.invalid,
        "The Monero app has not loaded its wallet keys. Close and reopen it, then try again."
      );
    case 0x6a30:
    case 0x6a31:
      return new ConnectError(
        ERROR_CODES.unsupported,
        "The installed Monero app does not support this client version. Update the Monero app in Ledger Live, then close Ledger Live and try again."
      );
    default:
      return ledgerError({ statusCode: status });
  }
}

export function ledgerError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  const tag =
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
      ? error._tag
      : error instanceof Error
        ? error.name
        : "";
  const legacyStatus =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
      ? error.statusCode.toString(16).padStart(4, "0")
      : "";
  const status =
    typeof error === "object" &&
    error !== null &&
    "errorCode" in error &&
    typeof error.errorCode === "string" &&
    /^[\da-f]{4}$/i.test(error.errorCode)
      ? error.errorCode.toLowerCase()
      : legacyStatus;
  if (tag === "DeviceLockedError" || status === "5515")
    return new ConnectError(
      ERROR_CODES.locked,
      "Unlock your Ledger with its PIN, open the selected network's app, and try again."
    );
  if (
    tag === "RefusedByUserDAError" ||
    tag === "UserRefusedOnDevice" ||
    ["5501", "6985", "6986"].includes(status)
  )
    return new ConnectError(
      ERROR_CODES.rejected,
      "The request was declined on your Ledger. Try again and confirm it on the device."
    );
  if (["6e00", "6d00", "6a82"].includes(status))
    return new ConnectError(
      ERROR_CODES.unsupported,
      `Ledger does not support this command (0x${status}). Open the selected network's app and check its version in Ledger Live.`
    );
  if (status === "6807")
    return new ConnectError(
      ERROR_CODES.unsupported,
      "The selected app is not installed on this Ledger. Install it in Ledger Live, then try again."
    );
  if (["6a80", "6984"].includes(status))
    return new ConnectError(
      ERROR_CODES.invalid,
      `Ledger rejected the request data (0x${status}). Check the account path and transaction details, then try again.`
    );
  if (
    tag === "UnsupportedFirmwareDAError" ||
    tag === "UnsupportedApplicationDAError"
  )
    return new ConnectError(
      ERROR_CODES.unsupported,
      "Ledger's installed app or firmware does not support this request. Check its version in Ledger Live."
    );
  if (
    error instanceof TimeoutError ||
    tag === "SendApduTimeoutError" ||
    tag === "SendCommandTimeoutError"
  )
    return new ConnectError(
      ERROR_CODES.disconnected,
      "Ledger did not respond in time. Unlock it, open the selected network's app, close other apps using the device, and try again."
    );
  if (tag === "DeviceBusyError")
    return new ConnectError(
      ERROR_CODES.busy,
      "Ledger is busy. Finish the current device request and close other apps using it."
    );
  // Preserve only error identifiers, never vendor messages or embedded payloads.
  const identifier = /^[A-Za-z][A-Za-z\d]{0,79}Error$/.test(tag) ? tag : "";
  const details = [identifier, status ? `0x${status}` : ""].filter(Boolean);
  return new ConnectError(
    ERROR_CODES.internal,
    `Ledger request failed${details.length ? ` (${details.join(", ")})` : ""}. Unlock the device, open the selected network's app, and try again.`
  );
}

export async function completeLedgerAction<O, E, I>(
  action: ExecuteDeviceActionReturnType<O, E, I>
): Promise<O> {
  try {
    return await firstValueFrom(
      action.observable.pipe(
        filter(
          (state) =>
            state.status === DeviceActionStatus.Completed ||
            state.status === DeviceActionStatus.Error ||
            state.status === DeviceActionStatus.Stopped
        ),
        map((state) => {
          if (state.status === DeviceActionStatus.Completed)
            return state.output;
          if (state.status === DeviceActionStatus.Error)
            throw ledgerError(state.error);
          throw new ConnectError(
            ERROR_CODES.rejected,
            "The Ledger request was cancelled. Try again and confirm it on the device."
          );
        }),
        timeout(290_000)
      )
    );
  } catch (error) {
    action.cancel();
    throw ledgerError(error);
  }
}
