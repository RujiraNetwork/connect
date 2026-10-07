import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ConnectError, ERROR_CODES } from "@rujira/connect-core";
import { z } from "zod";

import { WalletRpc } from "./rpc";

import type { ChildProcess } from "node:child_process";

export interface EngineConfig {
  readonly engineDirectory: string;
  readonly dataDirectory: string;
  readonly node: string;
  readonly extensionId: string;
}

async function ephemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Cannot allocate a local wallet port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    })
  );
  return address.port;
}

export class NativeWalletEngine {
  private child: ChildProcess | undefined;
  private rpc: WalletRpc | undefined;
  private passwordFile: string | undefined;
  private loginFile: string | undefined;
  constructor(private readonly config: EngineConfig) {}
  private binary(name: "monero-wallet-cli" | "monero-wallet-rpc"): string {
    return join(
      this.config.engineDirectory,
      `${name}${process.platform === "win32" ? ".exe" : ""}`
    );
  }
  walletPath(id: string): string {
    if (!/^[a-f\d-]{36}$/.test(id))
      throw new Error("Invalid wallet identifier");
    return join(this.config.dataDirectory, "wallets", id);
  }

  async available(): Promise<boolean> {
    try {
      await Promise.all([
        access(this.binary("monero-wallet-cli")),
        access(this.binary("monero-wallet-rpc")),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private async password(password: string): Promise<string> {
    await mkdir(this.config.dataDirectory, { recursive: true, mode: 0o700 });
    const path = join(
      this.config.dataDirectory,
      `.password-${randomBytes(16).toString("hex")}`
    );
    await writeFile(path, password, { mode: 0o600, flag: "wx" });
    this.passwordFile = path;
    return path;
  }

  async provisionHardware(
    id: string,
    password: string,
    source: "ledger" | "trezor",
    path: string,
    restoreHeight: number
  ): Promise<void> {
    await this.close();
    // Probe before touching the hardware; stock RPC cannot cold-sign a Trezor transfer.
    await this.open(undefined, password);
    await this.close();
    await mkdir(join(this.config.dataDirectory, "wallets"), {
      recursive: true,
      mode: 0o700,
    });
    const passwordFile = await this.password(password);
    const logFile = join(
      this.config.dataDirectory,
      `.engine-${randomBytes(8).toString("hex")}.log`
    );
    try {
      const child = spawn(
        this.binary("monero-wallet-cli"),
        [
          "--generate-from-device",
          this.walletPath(id),
          "--hw-device",
          source === "ledger" ? "Ledger" : "Trezor",
          ...(source === "trezor"
            ? ["--hw-device-deriv-path", path.replace(/^m\//, "")]
            : []),
          "--password-file",
          passwordFile,
          "--restore-height",
          String(restoreHeight),
          "--subaddress-lookahead",
          "1:1",
          "--offline",
          "--log-level",
          "0",
          "--log-file",
          logFile,
          "--command",
          "address",
          "device",
          "0",
        ],
        { stdio: ["ignore", "ignore", "ignore"], windowsHide: true }
      );
      this.child = child;
      await this.exited(child, 240_000);
    } finally {
      await this.close();
      await rm(logFile, { force: true });
    }
  }

  private async exited(
    child: ChildProcess,
    milliseconds: number
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Device registration timed out"));
      }, milliseconds);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("Monero device registration failed"));
      });
    });
  }

  async open(id: string | undefined, password: string): Promise<WalletRpc> {
    await this.close();
    const passwordFile = await this.password(password);
    const port = await ephemeralPort();
    const username = "rujira";
    const login = randomBytes(32).toString("hex");
    const loginFile = join(
      this.config.dataDirectory,
      `.rpc-${randomBytes(16).toString("hex")}.conf`
    );
    await writeFile(loginFile, `rpc-login=${username}:${login}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    this.loginFile = loginFile;
    await mkdir(join(this.config.dataDirectory, "wallets"), {
      recursive: true,
      mode: 0o700,
    });
    const logFile = join(this.config.dataDirectory, "engine.log");
    const args = [
      "--rpc-bind-ip",
      "127.0.0.1",
      "--rpc-bind-port",
      String(port),
      "--config-file",
      loginFile,
      "--daemon-address",
      this.config.node,
      "--untrusted-daemon",
      "--password-file",
      passwordFile,
      "--log-level",
      "0",
      "--log-file",
      logFile,
      "--no-initial-sync",
      ...(id
        ? ["--wallet-file", this.walletPath(id)]
        : ["--wallet-dir", join(this.config.dataDirectory, "wallets")]),
    ];
    this.child = spawn(this.binary("monero-wallet-rpc"), args, {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    const status = { failed: false };
    this.child.once("error", () => {
      status.failed = true;
    });
    const rpc = new WalletRpc(
      `http://127.0.0.1:${String(port)}`,
      username,
      login
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if (status.failed || !isRunning(this.child))
        throw new Error("Monero wallet engine failed to start");
      let version: unknown;
      try {
        version = await rpc.call("get_version", {}, 1000);
      } catch {
        await delay(100);
        continue;
      }
      if (
        !z.object({ rujira_device_signing: z.literal(1) }).safeParse(version)
          .success
      ) {
        await this.close();
        throw new ConnectError(
          ERROR_CODES.unsupported,
          "Install the Rujira device-signing Monero engine; the stock engine cannot sign Trezor transfers"
        );
      }
      this.rpc = rpc;
      return rpc;
    }
    await this.close();
    throw new Error("Monero wallet engine did not become ready");
  }

  async close(): Promise<void> {
    const child = this.child;
    const rpc = this.rpc;
    this.child = undefined;
    this.rpc = undefined;
    if (child && isRunning(child)) {
      try {
        if (rpc) {
          await rpc.call("store", {}, 5000);
          await rpc.call("stop_wallet", {}, 1000);
        }
      } catch {
        /* Closing must still terminate an unavailable native engine. */
      }
      child.kill();
      await Promise.race([
        new Promise<void>((resolve) => {
          if (!isRunning(child)) resolve();
          else
            child.once("exit", () => {
              resolve();
            });
        }),
        delay(2000),
      ]);
      if (isRunning(child)) child.kill("SIGKILL");
    }
    if (this.passwordFile) {
      await rm(this.passwordFile, { force: true });
      this.passwordFile = undefined;
    }
    if (this.loginFile) {
      await rm(this.loginFile, { force: true });
      this.loginFile = undefined;
    }
  }
}

export async function loadEngineConfig(path: string): Promise<EngineConfig> {
  const { z } = await import("zod");
  return z
    .object({
      engineDirectory: z.string().min(1),
      dataDirectory: z.string().min(1),
      node: z.string().url(),
      extensionId: z.string().regex(/^[a-p]{32}$/),
    })
    .strict()
    .parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}
