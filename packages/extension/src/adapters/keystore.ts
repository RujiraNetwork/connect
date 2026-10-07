import { blake2b } from "@noble/hashes/blake2";
import {
  ConnectError,
  ERROR_CODES,
  UNLOCK_DURATION_MS,
} from "@rujira/connect-core";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { z } from "zod";

import { equalBytes, fromHex } from "./bytes";

export const keystoreSchema = z
  .object({
    crypto: z
      .object({
        cipher: z.literal("aes-128-ctr"),
        ciphertext: z
          .string()
          .regex(/^(?:[a-fA-F0-9]{2})+$/)
          .max(2048),
        cipherparams: z
          .object({ iv: z.string().regex(/^[a-fA-F0-9]{32}$/) })
          .strict(),
        kdf: z.literal("pbkdf2"),
        kdfparams: z
          .object({
            prf: z.literal("hmac-sha256"),
            dklen: z.literal(32),
            salt: z.string().regex(/^[a-fA-F0-9]{64}$/),
            c: z.number().int().min(1).max(1000000),
          })
          .strict(),
        mac: z.string().regex(/^[a-fA-F0-9]{64}$/),
      })
      .strict(),
    id: z.string().max(128),
    version: z.literal(1),
    meta: z.string().max(128),
  })
  .strict();

export async function decryptKeystore(
  value: unknown,
  password: string
): Promise<Uint8Array<ArrayBuffer>> {
  const store = keystoreSchema.parse(value);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: fromHex(store.crypto.kdfparams.salt),
        iterations: store.crypto.kdfparams.c,
      },
      key,
      256
    )
  );
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    const ciphertext = fromHex(store.crypto.ciphertext);
    const macInput = new Uint8Array(16 + ciphertext.length);
    macInput.set(derived.subarray(16));
    macInput.set(ciphertext, 16);
    const mac = blake2b(macInput, { dkLen: 32 });
    if (!equalBytes(mac, fromHex(store.crypto.mac)))
      throw new ConnectError(
        ERROR_CODES.locked,
        "The keystore password is incorrect"
      );
    const aes = await crypto.subtle.importKey(
      "raw",
      derived.slice(0, 16),
      "AES-CTR",
      false,
      ["decrypt"]
    );
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-CTR",
          counter: fromHex(store.crypto.cipherparams.iv),
          length: 128,
        },
        aes,
        ciphertext
      )
    );
    const phrase = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (!validateMnemonic(phrase, wordlist))
      throw new ConnectError(
        ERROR_CODES.invalid,
        "This file does not contain a valid THORChain/XChain mnemonic"
      );
    return new Uint8Array(mnemonicToSeedSync(phrase));
  } finally {
    derived.fill(0);
    plaintext?.fill(0);
  }
}

export class KeystoreSessions {
  private readonly unlocking = new Map<string, symbol>();
  private readonly sessions = new Map<
    string,
    { seed: Uint8Array<ArrayBuffer>; expiresAt: number }
  >();
  constructor(private readonly clock: () => number = Date.now) {}
  async unlock(
    sourceId: string,
    encrypted: unknown,
    password: string
  ): Promise<void> {
    const ticket = Symbol(sourceId);
    this.unlocking.set(sourceId, ticket);
    let seed: Uint8Array<ArrayBuffer>;
    try {
      seed = await decryptKeystore(encrypted, password);
    } catch (error) {
      if (this.unlocking.get(sourceId) === ticket)
        this.unlocking.delete(sourceId);
      throw error;
    }
    if (this.unlocking.get(sourceId) !== ticket) {
      seed.fill(0);
      throw new ConnectError(
        ERROR_CODES.locked,
        "Unlock was cancelled because the source was locked"
      );
    }
    this.lock(sourceId);
    this.sessions.set(sourceId, {
      seed,
      expiresAt: this.clock() + UNLOCK_DURATION_MS,
    });
  }
  seed(sourceId: string): Uint8Array<ArrayBuffer> {
    const session = this.sessions.get(sourceId);
    if (!session || session.expiresAt <= this.clock()) {
      this.lock(sourceId);
      throw new ConnectError(
        ERROR_CODES.locked,
        "Unlock this keystore in Rujira Connect"
      );
    }
    return session.seed;
  }
  unlockedUntil(sourceId: string): number | undefined {
    try {
      this.seed(sourceId);
      return this.sessions.get(sourceId)?.expiresAt;
    } catch {
      return undefined;
    }
  }
  lock(sourceId?: string): void {
    if (sourceId === undefined) this.unlocking.clear();
    else this.unlocking.delete(sourceId);
    for (const [id, session] of this.sessions)
      if (sourceId === undefined || sourceId === id) {
        session.seed.fill(0);
        this.sessions.delete(id);
      }
  }
}
