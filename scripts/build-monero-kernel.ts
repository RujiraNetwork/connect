import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const output = "packages/extension/src/adapters/monero-kernel";
await mkdir(output, { recursive: true });
execFileSync(
  "cargo",
  [
    "+1.95.0",
    "build",
    "--locked",
    "--manifest-path",
    "packages/monero-kernel/Cargo.toml",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
  ],
  { stdio: "inherit" }
);
execFileSync(
  process.env.RUJIRA_WASM_BINDGEN ?? "wasm-bindgen",
  [
    "packages/monero-kernel/target/wasm32-unknown-unknown/release/rujira_monero_kernel.wasm",
    "--target",
    "web",
    "--out-dir",
    output,
    "--out-name",
    "kernel",
  ],
  { stdio: "inherit" }
);
const original = await readFile(`${output}/kernel.js`, "utf8");
// Only synchronous, byte-backed initialization. No URL loader or fetch code.
const glue =
  original.slice(0, original.indexOf("async function __wbg_load")) +
  original.slice(
    original.indexOf("function initSync"),
    original.indexOf("async function __wbg_init")
  ) +
  "export { initSync };\nexport function wipe() { if (wasm) new Uint8Array(wasm.memory.buffer).fill(0); wasm = undefined; }\n";
await writeFile(`${output}/kernel.js`, glue);
await writeFile(
  `${output}/kernel.d.ts`,
  ((await readFile(`${output}/kernel.d.ts`, "utf8")).split(
    "/**\n * If `module_or_path`"
  )[0] ?? "") + "\nexport function wipe(): void;\n"
);
await writeFile(
  `${output}/kernel.base64`,
  (await readFile(`${output}/kernel_bg.wasm`)).toString("base64")
);
await rm(`${output}/kernel_bg.wasm`);
await rm(`${output}/kernel_bg.wasm.d.ts`);
