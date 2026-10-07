import { describe, expect, it } from "vitest";

import { NativeMessageDecoder, encodeNativeMessage } from "./framing";
import { validateNode } from "./policy";

describe("native companion boundary", () => {
  it("decodes UTF-8 messages across every possible chunk boundary", () => {
    const value = { message: "Rujira · 接続", id: 1 };
    const encoded = encodeNativeMessage(value);
    for (let index = 0; index < encoded.length; index++) {
      const decoder = new NativeMessageDecoder();
      const first = decoder.feed(encoded.subarray(0, index));
      const second = decoder.feed(encoded.subarray(index));
      expect([...first, ...second]).toEqual([value]);
      decoder.finish();
    }
  });
  it("decodes multiple messages and rejects truncated or oversized frames", () => {
    expect(
      new NativeMessageDecoder().feed(
        Buffer.concat([
          encodeNativeMessage({ a: 1 }),
          encodeNativeMessage({ b: 2 }),
        ])
      )
    ).toEqual([{ a: 1 }, { b: 2 }]);
    const decoder = new NativeMessageDecoder();
    decoder.feed(Buffer.from([5, 0, 0, 0, 1]));
    expect(() => {
      decoder.finish();
    }).toThrow("Incomplete");
    expect(() =>
      new NativeMessageDecoder().feed(Buffer.from([255, 255, 255, 127]))
    ).toThrow("length");
  });
  it("allows encrypted public nodes and explicit local nodes", () => {
    expect(validateNode("https://xmr-node.cakewallet.com:18081")).toBe(
      "https://xmr-node.cakewallet.com:18081"
    );
    expect(validateNode("http://localhost:18081")).toBe(
      "http://localhost:18081"
    );
    for (const url of [
      "http://remote.example:18081",
      "https://user:password@remote.example",
      "file:///tmp/node",
      "https://remote.example/?secret=1",
    ])
      expect(() => validateNode(url)).toThrow();
  });
});
