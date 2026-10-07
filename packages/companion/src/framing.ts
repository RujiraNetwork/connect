import { MAX_MESSAGE_BYTES } from "@rujira/connect-core";

export class NativeMessageDecoder {
  private pending = Buffer.alloc(0);
  feed(chunk: Buffer): unknown[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const messages: unknown[] = [];
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (length === 0 || length > MAX_MESSAGE_BYTES)
        throw new Error("Invalid native message length");
      if (this.pending.length < length + 4) break;
      messages.push(
        JSON.parse(
          this.pending.subarray(4, length + 4).toString("utf8")
        ) as unknown
      );
      this.pending = this.pending.subarray(length + 4);
    }
    return messages;
  }
  finish(): void {
    if (this.pending.length !== 0) throw new Error("Incomplete native message");
  }
}

export function encodeNativeMessage(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_MESSAGE_BYTES)
    throw new Error("Native response exceeds the message limit");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}
