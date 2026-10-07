import { Buffer } from "buffer";

export function fromHex(value: string): Uint8Array<ArrayBuffer> {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^(?:[a-fA-F0-9]{2})*$/.test(hex))
    throw new Error("Invalid hexadecimal bytes");
  return new Uint8Array(Buffer.from(hex, "hex"));
}
export function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}
export function hex0x(value: Uint8Array): `0x${string}` {
  return `0x${toHex(value)}`;
}
export function base64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new Error("Invalid base64 bytes");
  return new Uint8Array(Buffer.from(value, "base64"));
}
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}
