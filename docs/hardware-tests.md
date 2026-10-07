# Connection and signing tests

All fixtures use the public BIP39 `abandon` mnemonic ending in `about`. No personal wallet, real funds, node or broadcast is involved. The main suite covers every advertised keystore and Ledger native method, plus permission/lifecycle checks and Trezor SDK/Monero regression fixtures:

```sh
pnpm test
pnpm build
pnpm test:browser
```

Ledger Monero tests use the published `@ledgerhq/hw-transport-mocker` 6.35.0. APDU recordings come from the real Nano S Monero app 2.1.1, source commit `7cf472121485d3ea781a241571fbdd8d94b7fc4d`, compiled with `DEBUG=0` and run on Speculos 0.23.0. Positions 0, 2 and 15 exercise CLSAG ring wraparound. A fourth recording covers two inputs, a minor subaddress and an additional transaction key. Negative tests alter recorded responses and verify refusal, session close and cleanup. Other Ledger methods use the real vendor SDKs with valid native signing results at their device boundary; Cosmos tests additionally check its real APDU encoding. These are adapter tests, not firmware certification for every Ledger app.

Trezor firmware tests use the published trezor-user-env image pinned in `scripts/hardware/compose.yaml`. Model T 2.12.5 exercises all 23 advertised native connection/signing methods, including prepared Monero signing, plus the THORChain Ethereum address profile and its custom EIP-712 domain. The test-only local Bridge transport connects SDK protobuf calls to the emulator. Production uses direct WebUSB and includes no Bridge, HTTP service or companion app. The controller confirms only public fixture requests and resets its own emulated device.

To run the firmware tests (requires Docker and initial image/source downloads):

```sh
docker compose -f scripts/hardware/compose.yaml up --build -d
RUJIRA_SPECULOS_URL=http://127.0.0.1:5010 RUJIRA_TREZOR_EMULATOR=1 pnpm test:hardware
docker compose -f scripts/hardware/compose.yaml down
```

This setup was verified on Apple Silicon with `2.12.5-arm`. Set `RUJIRA_TREZOR_FIRMWARE` to a release available in the vendor controller for your host architecture. Run one suite per emulator. `RUJIRA_RECORD_HARDWARE=1` replaces the checked-in public Ledger Monero and Trezor signing recordings; review fixture changes before accepting them.

Firmware emulators check real protocol handling and native signatures. They do not validate a physical USB/HID stack, user-device firmware combinations or chain availability. Physical-device acceptance remains documented in [Validation](validation.md).
