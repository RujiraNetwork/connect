declare module "cashaddrjs" {
  const cashaddr: {
    encode(prefix: string, type: "P2PKH" | "P2SH", hash: Uint8Array): string;
    decode(address: string): {
      prefix: string;
      type: "P2PKH" | "P2SH";
      hash: Uint8Array;
    };
  };
  export default cashaddr;
}
