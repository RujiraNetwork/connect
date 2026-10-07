import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { COMPANION_NAME, DEFAULT_MONERO_NODE } from "@rujira/connect-core";

import { validateNode } from "./policy";

async function install(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "extension-id": { type: "string" },
      "engine-dir": { type: "string" },
      node: { type: "string", default: DEFAULT_MONERO_NODE },
    },
  });
  const extensionId = values["extension-id"];
  const engineInput = values["engine-dir"];
  if (!extensionId || !/^[a-p]{32}$/.test(extensionId) || !engineInput)
    throw new Error(
      "Usage: pnpm companion:install --extension-id <Chrome extension ID> --engine-dir <verified Monero binary directory>"
    );
  const engineDirectory = await realpath(resolve(engineInput));
  const dataDirectory =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? homedir(), "Rujira", "Connect")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "Rujira Connect")
        : join(homedir(), ".local", "share", "rujira-connect");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const configPath = join(dataDirectory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        extensionId,
        engineDirectory,
        dataDirectory,
        node: validateNode(values.node),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  const installedHost = join(dataDirectory, "host.mjs");
  await copyFile(resolve("packages/companion/dist/index.js"), installedHost);
  const launcher = join(
    dataDirectory,
    process.platform === "win32" ? "launch.cmd" : "launch"
  );
  const quote = (value: string): string =>
    `'${value.replaceAll("'", "'\\''")}'`;
  const content =
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${installedHost}" --config "${configPath}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(installedHost)} --config ${quote(configPath)} "$@"\n`;
  await writeFile(launcher, content, { mode: 0o700 });
  await chmod(launcher, 0o700);
  const manifest = {
    name: COMPANION_NAME,
    description: "Rujira Connect Monero signing companion",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const manifestPath =
    process.platform === "win32"
      ? join(dataDirectory, `${COMPANION_NAME}.json`)
      : process.platform === "darwin"
        ? join(
            homedir(),
            "Library",
            "Application Support",
            "Google",
            "Chrome",
            "NativeMessagingHosts",
            `${COMPANION_NAME}.json`
          )
        : join(
            homedir(),
            ".config",
            "google-chrome",
            "NativeMessagingHosts",
            `${COMPANION_NAME}.json`
          );
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
  if (process.platform === "win32")
    execFileSync(
      "reg.exe",
      [
        "ADD",
        `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${COMPANION_NAME}`,
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        manifestPath,
        "/f",
      ],
      { stdio: "ignore" }
    );
  process.stdout.write(
    `Installed Rujira Connect companion for ${extensionId}.\n`
  );
}

install().catch((error: unknown) => {
  process.stderr.write(
    error instanceof Error
      ? `${error.message}\n`
      : "Companion installation failed.\n"
  );
  process.exitCode = 1;
});
