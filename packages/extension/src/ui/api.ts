import {
  ConnectError,
  ERROR_CODES,
  responseSchema,
  uiRequestSchema,
} from "@rujira/connect-core";

import type { UiRequest } from "@rujira/connect-core";

export async function callUi(request: UiRequest): Promise<unknown> {
  uiRequestSchema.parse(request);
  if (
    location.protocol !== "chrome-extension:" ||
    typeof chrome === "undefined" ||
    !chrome.runtime.id
  )
    throw new ConnectError(
      ERROR_CODES.disconnected,
      "Load the built Rujira Connect extension in Chrome to use your signing accounts"
    );
  const response = responseSchema.parse(
    await chrome.runtime.sendMessage(request)
  );
  if (!response.ok)
    throw new ConnectError(response.error.code, response.error.message);
  return response.result;
}

export function messageOf(error: unknown): string {
  return error instanceof ConnectError
    ? error.message
    : "This request could not be completed. Check your device or keystore and try again.";
}

interface HidDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
}
interface HidAccess {
  requestDevice(options: {
    filters: { vendorId: number }[];
  }): Promise<HidDevice[]>;
}
export async function chooseLedger(): Promise<void> {
  if (!("hid" in navigator))
    throw new ConnectError(
      ERROR_CODES.unsupported,
      "Use a desktop Chromium browser with WebHID"
    );
  const hid = navigator.hid as HidAccess;
  const devices = await hid.requestDevice({ filters: [{ vendorId: 0x2c97 }] });
  if (!devices.length)
    throw new ConnectError(ERROR_CODES.rejected, "No Ledger was selected");
  await callUi({ action: "deviceGranted" });
}

export async function chooseTrezor(): Promise<void> {
  if (!("usb" in navigator))
    throw new ConnectError(
      ERROR_CODES.unsupported,
      "Use desktop Chrome to connect your Trezor by USB."
    );
  const usb = navigator.usb as {
    requestDevice: (options: {
      filters: { vendorId: number; productId: number }[];
    }) => Promise<unknown>;
  };
  await usb.requestDevice({
    filters: [
      { vendorId: 0x534c, productId: 0x0001 },
      { vendorId: 0x1209, productId: 0x53c1 },
    ],
  });
  await callUi({ action: "deviceGranted" });
}
