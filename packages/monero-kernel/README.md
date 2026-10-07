# Offline Monero cryptography

This small Rust library supplies Monero hash-to-point, commitments, two-output Bulletproof+ generation, keystore input/key-image derivation, CLSAG signing and native transaction verification. It does not include wallet scanning, RPC, networking, broadcasting or device transport. JavaScript supplies WebCrypto entropy and synchronously loads the checked-in module from packaged bytes. There is no URL loader. Signing erases secret buffers and the entire WebAssembly linear memory.

The four monero-oxide dependencies are pinned to commit `731657ae3385be667abb556266369a497bc86f13`; all resolved Rust dependencies are locked in `Cargo.lock`. Generated JavaScript, declarations and base64 module bytes live in `packages/extension/src/adapters/monero-kernel`. Normal extension builds use those files without requiring Rust.

To rebuild after changing Rust source:

```sh
rustup toolchain install 1.95.0
rustup target add --toolchain 1.95.0 wasm32-unknown-unknown
cargo +1.95.0 install wasm-bindgen-cli --version 0.2.118 --locked
pnpm build:monero
pnpm check
```

`RUJIRA_WASM_BINDGEN` can point to a matching wasm-bindgen binary. The generator removes asynchronous loaders and exports only byte-backed synchronous initialization and the crypto functions. The extension CSP permits packaged WebAssembly while retaining `connect-src 'none'`.

The crypto implementation comes from [monero-oxide](https://github.com/monero-oxide/monero-oxide), licensed under MIT. Dependency notices are included in `licenses/`; consult each dependency's license before redistribution. The wrapper and dependency integration require independent security review before public release.
