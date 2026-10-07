import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

/** Monero wallet RPC uses HTTP Digest; credentials are random for each local process. */
export class WalletRpc {
  private nonceCount = 0;
  constructor(
    private readonly endpoint: string,
    private readonly username: string,
    private readonly password: string
  ) {}
  async call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 240_000
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params,
    });
    const options = {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    };
    let response = await fetch(`${this.endpoint}/json_rpc`, options);
    if (response.status === 401) {
      const challenge = response.headers.get("www-authenticate") ?? "";
      const fields = Object.fromEntries<string | undefined>(
        Array.from(
          challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^, ]+))/g),
          (match) => [match[1] ?? "", match[2] ?? match[3]] as const
        )
      );
      const realm = fields.realm;
      const nonce = fields.nonce;
      if (
        !realm ||
        !nonce ||
        (fields.algorithm && fields.algorithm.toUpperCase() !== "MD5") ||
        !fields.qop?.split(",").includes("auth")
      )
        throw new Error("Unsupported wallet RPC authentication");
      const cnonce = randomBytes(16).toString("hex");
      const nc = (++this.nonceCount).toString(16).padStart(8, "0");
      const digest = md5(
        `${md5(`${this.username}:${realm}:${this.password}`)}:${nonce}:${nc}:${cnonce}:auth:${md5("POST:/json_rpc")}`
      );
      const authorization = `Digest username="${this.username}", realm="${realm}", nonce="${nonce}", uri="/json_rpc", response="${digest}", qop=auth, nc=${nc}, cnonce="${cnonce}"${fields.opaque ? `, opaque="${fields.opaque}"` : ""}`;
      response = await fetch(`${this.endpoint}/json_rpc`, {
        ...options,
        headers: { ...options.headers, Authorization: authorization },
      });
    }
    if (!response.ok) throw new Error("Wallet RPC is unavailable");
    const parsed = z
      .object({
        result: z.record(z.unknown()).optional(),
        error: z.object({ code: z.number(), message: z.string() }).optional(),
      })
      .parse(await response.json());
    if (parsed.error || !parsed.result)
      throw new Error("Wallet engine rejected the request");
    return parsed.result;
  }
}
