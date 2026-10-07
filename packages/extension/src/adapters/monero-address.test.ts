import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";

import { moneroAddress, moneroPublicKeys } from "./monero-keys";

describe("offline Monero public address validation", () => {
  const spend = ed25519.Point.BASE.multiply(123n).toBytes();
  const view = ed25519.Point.BASE.multiply(456n).toBytes();
  const address = moneroAddress(spend, view);
  it("recovers the public spend and view keys without any private key", () => {
    const decoded = moneroPublicKeys(address);
    expect(decoded.publicSpend).toEqual(spend);
    expect(decoded.publicView).toEqual(view);
    expect(moneroAddress(decoded.publicSpend, decoded.publicView)).toBe(
      address
    );
  });
  it.each([
    "",
    "invalid",
    address.slice(0, -1),
    `${address.slice(0, -1)}${address.endsWith("1") ? "2" : "1"}`,
    `0${address.slice(1)}`,
  ])("rejects malformed addresses and damaged checksums", (value) => {
    expect(() => moneroPublicKeys(value)).toThrow();
  });
});
