import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const RELEASE = "dbcc7d212c094bd1a45f7291dbb99a4b4627a96d"; // Monero v0.18.4.6
const { values } = parseArgs({
  options: {
    source: { type: "string" },
    jobs: { type: "string", default: "2" },
  },
});
if (!values.source || !/^\d+$/.test(values.jobs) || Number(values.jobs) < 1)
  throw new Error(
    "Usage: pnpm companion:build-engine --source <new build directory> [--jobs 2]"
  );
const source = resolve(values.source);
await mkdir(source, { recursive: false });
function run(command: string, args: string[]): void {
  execFileSync(command, args, { cwd: source, stdio: "inherit" });
}
run("git", ["init"]);
run("git", [
  "remote",
  "add",
  "origin",
  "https://github.com/monero-project/monero.git",
]);
run("git", ["fetch", "--depth", "1", "origin", RELEASE]);
run("git", ["checkout", "--detach", "FETCH_HEAD"]);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: source,
  encoding: "utf8",
}).trim();
if (commit !== RELEASE)
  throw new Error("Monero source commit did not match the pinned release");
run("git", ["submodule", "update", "--init", "--recursive", "--depth", "1"]);
const patch = resolve("packages/companion/native/device-signing.patch");
await readFile(patch); // Fail before configuration if the local reviewed patch is missing.
run("git", ["apply", "--check", patch]);
run("git", ["apply", patch]);
run("cmake", [
  "-S",
  ".",
  "-B",
  "build/rujira",
  "-DCMAKE_BUILD_TYPE=Release",
  "-DBUILD_TESTS=OFF",
  "-DUSE_DEVICE_TREZOR=ON",
  "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
]);
const trezorFlags = await readFile(
  resolve(
    source,
    "build/rujira/src/device_trezor/CMakeFiles/device_trezor.dir/flags.make"
  ),
  "utf8"
);
if (!trezorFlags.includes("DEVICE_TREZOR_READY=1"))
  throw new Error(
    "Trezor support was disabled during configuration. Install the documented protobuf and Python dependencies before building."
  );
const commands = await readFile(
  resolve(source, "build/rujira/compile_commands.json"),
  "utf8"
);
if (!commands.includes("device_ledger.cpp"))
  throw new Error(
    "Ledger HID support was disabled. Install HIDAPI before building."
  );
run("cmake", [
  "--build",
  "build/rujira",
  "--target",
  "simplewallet",
  "wallet_rpc_server",
  "--parallel",
  values.jobs,
]);
process.stdout.write(
  `Rujira Monero engine built in ${source}/build/rujira/bin\n`
);
