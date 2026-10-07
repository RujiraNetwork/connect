import { Buffer } from "buffer";

import {
  DeviceManagementKitBuilder,
  OpenAppDeviceAction,
} from "@ledgerhq/device-management-kit";
import {
  DefaultDescriptorTemplate,
  DefaultWallet,
  SignerBtcBuilder,
} from "@ledgerhq/device-signer-kit-bitcoin";
import { SignerEthBuilder } from "@ledgerhq/device-signer-kit-ethereum";
import { SignerSolanaBuilder } from "@ledgerhq/device-signer-kit-solana";
import { webHidTransportFactory } from "@ledgerhq/device-transport-kit-web-hid";
import Btc from "@ledgerhq/hw-app-btc";
import Cosmos from "@ledgerhq/hw-app-cosmos";
import Trx from "@ledgerhq/hw-app-trx";
import Xrp from "@ledgerhq/hw-app-xrp";
import Transport from "@ledgerhq/hw-transport";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  CHAINS,
  ConnectError,
  ERROR_CODES,
  canonicalJson,
  validateSignAccount,
  validateLedgerAccountPath,
} from "@rujira/connect-core";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { PublicKey } from "@solana/web3.js";
import THORChainApp from "@xchainjs/ledger-thorchain";
import { Psbt } from "bitcoinjs-lib";
import { Signature, SigningKey, getBytes } from "ethers";
import { firstValueFrom, filter, map, timeout } from "rxjs";
import { encode, validate } from "xrpl";

import { base64, fromHex, toHex } from "./bytes";
import { addressFor, utxoNetwork } from "./keys";
import {
  completeLedgerAction as complete,
  ledgerError,
  moneroLedgerError,
} from "./ledger-actions";
import { signLedgerMonero } from "./ledger-monero";
import { moneroAddress, moneroPublicKeys } from "./monero-keys";
import { validateMoneroTransaction } from "./monero-transactions";
import { offlineContext } from "./offline-context";
import {
  evmTransaction,
  solanaTransaction,
  typedData,
  validatePsbt,
  validateTron,
  validateUtxo,
} from "./transactions";

import type {
  DeviceManagementKit,
  Transport as LedgerHidTransport,
  TransportConnectedDevice,
} from "@ledgerhq/device-management-kit";
import type { Account, SignRequest } from "@rujira/connect-core";
import type { Transaction as XrpTransaction } from "xrpl";

/** Protocol compatibility only: every APDU goes through the current DMK WebHID session. */
class DmkProtocolTransport extends Transport {
  constructor(
    private readonly dmk: DeviceManagementKit,
    private readonly sessionId: string
  ) {
    super();
  }
  override async exchange(apdu: Buffer): Promise<Buffer> {
    try {
      const response = await this.dmk.sendApdu({
        sessionId: this.sessionId,
        apdu,
        abortTimeout: 290_000,
      });
      return Buffer.concat([
        Buffer.from(response.data),
        Buffer.from(response.statusCode),
      ]);
    } catch (error) {
      throw ledgerError(error);
    }
  }
}

export function pathNumbers(path: string): number[] {
  return path
    .split("/")
    .slice(1)
    .map(
      (segment) =>
        Number.parseInt(segment, 10) + (segment.endsWith("'") ? 0x80000000 : 0)
    );
}

export class LedgerAdapter {
  private readonly dmk: DeviceManagementKit;
  private hid: LedgerHidTransport | undefined;
  private moneroDevice: TransportConnectedDevice | undefined;
  constructor(dmk?: DeviceManagementKit, hid?: LedgerHidTransport) {
    this.hid = hid;
    this.dmk =
      dmk ??
      new DeviceManagementKitBuilder()
        .addTransport((dependencies) => {
          const transport = webHidTransportFactory(dependencies);
          this.hid = transport;
          return transport;
        })
        .build();
  }
  private sessionId: string | undefined;
  private deviceId: string | undefined;
  private deviceName: string | undefined;

  async disconnect(): Promise<void> {
    const sessionId = this.sessionId;
    const moneroDevice = this.moneroDevice;
    this.moneroDevice = undefined;
    this.sessionId = undefined;
    this.deviceId = undefined;
    this.deviceName = undefined;
    if (sessionId) await this.dmk.disconnect({ sessionId });
    if (moneroDevice && this.hid)
      await this.hid.disconnect({ connectedDevice: moneroDevice });
  }

  private async session(deviceId?: string): Promise<string> {
    if (this.sessionId && (!deviceId || this.deviceId === deviceId))
      return this.sessionId;
    await this.disconnect();
    const device = await firstValueFrom(
      this.dmk.listenToAvailableDevices({}).pipe(
        // WebHID IDs are temporary. A saved ID is only a preference; the
        // registered public key is checked again before any signing request.
        map(
          (devices) =>
            devices.find((entry) => !deviceId || entry.id === deviceId) ??
            (devices.length === 1 ? devices[0] : undefined)
        ),
        filter((entry) => entry !== undefined),
        timeout(10_000)
      )
    );
    this.sessionId = await this.dmk.connect({
      device,
      sessionRefresherOptions: { isRefresherDisabled: true },
    });
    this.deviceId = device.id;
    this.deviceName = device.deviceModel.name.startsWith("Ledger")
      ? device.deviceModel.name
      : `Ledger ${device.deviceModel.name}`;
    return this.sessionId;
  }

  private async protocol(
    account: Account,
    deviceId?: string
  ): Promise<DmkProtocolTransport> {
    const sessionId = await this.session(deviceId);
    await complete(
      this.dmk.executeDeviceAction({
        sessionId,
        deviceAction: new OpenAppDeviceAction({
          input: { appName: CHAINS[account.chain].app },
        }),
      })
    );
    return new DmkProtocolTransport(this.dmk, sessionId);
  }

  async register(
    account: Account,
    deviceId?: string,
    knownAccounts: readonly Account[] = []
  ): Promise<{
    account: Account;
    deviceId: string;
    deviceName: string;
    matchedSourceId?: string;
  }> {
    try {
      validateLedgerAccountPath(account);
      if (account.chain === "XMR") {
        const read = await this.readMoneroAccount(account, deviceId);
        const known = knownAccounts.find(
          (entry) =>
            entry.chain === "XMR" &&
            entry.address === read.address &&
            entry.publicKey === read.publicKey
        );
        return {
          account: read,
          deviceId: this.deviceId ?? "",
          deviceName: this.deviceName ?? "Ledger",
          ...(known ? { matchedSourceId: known.sourceId } : {}),
        };
      }
      await this.session(deviceId);
      let matchedSourceId: string | undefined;
      const checked = new Set<string>();
      // Ledger deliberately exposes no persistent hardware serial number.
      // Re-read a known public key to recognise a wallet after reconnecting.
      for (const known of knownAccounts.toSorted(
        (left, right) =>
          Number(right.chain === account.chain) -
          Number(left.chain === account.chain)
      )) {
        if (
          known.chain === "XMR" ||
          !known.publicKey ||
          checked.has(known.sourceId)
        )
          continue;
        checked.add(known.sourceId);
        try {
          const read = await this.readAccount(known, this.deviceId, false);
          if (
            read.publicKey === known.publicKey &&
            read.address === known.address
          ) {
            matchedSourceId = known.sourceId;
            break;
          }
        } catch (error) {
          const failure = ledgerError(error);
          if (
            failure.code !== ERROR_CODES.unsupported &&
            failure.code !== ERROR_CODES.invalid
          )
            throw failure;
        }
      }
      return {
        account: await this.readAccount(account, this.deviceId),
        deviceId: this.deviceId ?? "",
        deviceName: this.deviceName ?? "Ledger",
        ...(matchedSourceId ? { matchedSourceId } : {}),
      };
    } catch (error) {
      throw ledgerError(error);
    }
  }

  private async readMoneroAccount(
    account: Account,
    deviceId?: string
  ): Promise<Account> {
    let step = "connecting to your Ledger";
    try {
      await this.disconnect();
      const device = await firstValueFrom(
        this.dmk.listenToAvailableDevices({}).pipe(
          map(
            (devices) =>
              devices.find((entry) => !deviceId || entry.id === deviceId) ??
              (devices.length === 1 ? devices[0] : undefined)
          ),
          filter((entry) => entry !== undefined),
          timeout(10_000)
        )
      );
      const hid = this.hid;
      if (!hid)
        throw new ConnectError(
          ERROR_CODES.disconnected,
          "Ledger HID transport is unavailable."
        );
      // Connect at the transport layer: DMK's Nano S session pinger sends OS
      // commands before the app handshake. Monero needs only its own APDUs.
      this.moneroDevice = (
        await hid.connect({
          deviceId: device.id,
          onDisconnect: () => {
            this.moneroDevice = undefined;
          },
        })
      ).caseOf({
        Left: (error) => {
          throw ledgerError(error);
        },
        Right: (connected) => connected,
      });
      this.deviceId = device.id;
      this.deviceName = device.deviceModel.name.startsWith("Ledger")
        ? device.deviceModel.name
        : `Ledger ${device.deviceModel.name}`;
      const exchange = async (
        apdu: number[],
        abortTimeout = 10_000
      ): Promise<Uint8Array> => {
        return this.moneroExchange(new Uint8Array(apdu), abortTimeout);
      };
      step = "starting the Monero connection";
      const version = [...new TextEncoder().encode("0.18.4.6")];
      const reset = await exchange([
        4,
        2,
        0,
        0,
        version.length + 1,
        0,
        ...version,
      ]);
      if (reset.length < 3)
        throw new ConnectError(
          ERROR_CODES.invalid,
          "Ledger returned an incomplete Monero app version."
        );
      step = "reading your Monero address";
      const response = await exchange([4, 0x20, 1, 0, 1, 0]);
      if (response.length !== 159)
        throw new ConnectError(
          ERROR_CODES.invalid,
          "Ledger returned an incomplete Monero address."
        );
      const address = moneroAddress(
        response.subarray(32, 64),
        response.subarray(0, 32)
      );
      if (new TextDecoder().decode(response.subarray(64)) !== address)
        throw new ConnectError(
          ERROR_CODES.invalid,
          "The Monero address does not match its public keys."
        );
      step = "waiting for address confirmation";
      await exchange([4, 0x21, 0, 0, 17, ...new Uint8Array(17)], 290_000);
      return {
        ...account,
        address,
        publicKey: moneroPublicKeys(address).publicKey,
      };
    } catch (error) {
      const failure = ledgerError(error);
      await this.disconnect();
      throw new ConnectError(
        failure.code,
        `Could not finish ${step}. ${failure.message}`
      );
    }
  }

  private async moneroExchange(
    apdu: Uint8Array,
    abortTimeout = 10_000
  ): Promise<Uint8Array> {
    const connected = this.moneroDevice;
    if (!connected)
      throw new ConnectError(
        ERROR_CODES.disconnected,
        "Your Ledger was disconnected."
      );
    const response = (
      await connected.sendApdu(apdu, false, abortTimeout)
    ).caseOf({
      Left: (error) => {
        throw ledgerError(error);
      },
      Right: (result) => result,
    });
    const status =
      (response.statusCode[0] ?? 0) * 256 + (response.statusCode[1] ?? 0);
    if (status !== 0x9000) throw moneroLedgerError(status);
    return response.data;
  }

  private async readAccount(
    account: Account,
    deviceId?: string,
    checkOnDevice = true
  ): Promise<Account> {
    validateLedgerAccountPath(account);
    const sessionId = await this.session(deviceId);
    // Signer kits expect BIP32 components without the master key's `m/` prefix.
    const path = account.path.replace(/^m\//, "");
    let publicKey: Uint8Array;
    let displayed: string;
    if (CHAINS[account.chain].family === "evm" || account.scheme === "eip712") {
      const signer = new SignerEthBuilder({ dmk: this.dmk, sessionId })
        .withContextModule(offlineContext)
        .build();
      const result = await complete(signer.getAddress(path, { checkOnDevice }));
      publicKey = getBytes(
        SigningKey.computePublicKey(
          `0x${toHex(fromHex(result.publicKey))}`,
          true
        )
      );
      displayed = result.address;
    } else if (account.chain === "BTC") {
      const signer = new SignerBtcBuilder({ dmk: this.dmk, sessionId }).build();
      const accountPath = path.split("/").slice(0, 3).join("/");
      const xpub = await complete(signer.getExtendedPublicKey(accountPath));
      const derived = HDKey.fromExtendedKey(xpub.extendedPublicKey).derive(
        "m/0/0"
      ).publicKey;
      if (!derived)
        throw new ConnectError(
          ERROR_CODES.invalid,
          "Ledger returned an invalid public key"
        );
      publicKey = derived;
      displayed = (
        await complete(
          signer.getWalletAddress(this.wallet(account), 0, {
            checkOnDevice,
          })
        )
      ).address;
    } else if (account.chain === "SOL") {
      const signer = new SignerSolanaBuilder({
        dmk: this.dmk,
        sessionId,
      })
        .withContextModule(offlineContext)
        .build();
      displayed = await complete(signer.getAddress(path, { checkOnDevice }));
      publicKey = base58.decode(displayed);
    } else {
      const transport = await this.protocol(account, deviceId);
      if (account.chain === "THOR") {
        const app = new THORChainApp(transport);
        const result = await (
          checkOnDevice
            ? app.showAddressAndPubKey.bind(app)
            : app.getAddressAndPubKey.bind(app)
        )(pathNumbers(account.path), "thor");
        if (result.returnCode !== 0x9000)
          throw new ConnectError(
            ERROR_CODES.rejected,
            "Open the THORChain app and confirm the address on Ledger"
          );
        publicKey = result.compressedPk;
        displayed = result.bech32Address;
      } else if (account.chain === "GAIA") {
        const result = await new Cosmos(transport).getAddress(
          path,
          "cosmos",
          checkOnDevice
        );
        publicKey = fromHex(result.publicKey);
        displayed = result.address;
      } else if (account.chain === "XRP") {
        const result = await new Xrp(transport).getAddress(path, checkOnDevice);
        publicKey = fromHex(result.publicKey);
        displayed = result.address;
      } else if (account.chain === "TRON") {
        const result = await new Trx(transport).getAddress(path, checkOnDevice);
        publicKey = getBytes(
          SigningKey.computePublicKey(`0x${result.publicKey}`, true)
        );
        displayed = result.address;
      } else if (CHAINS[account.chain].family === "utxo") {
        const result = await new Btc({
          transport,
          currency:
            account.chain === "LTC"
              ? "litecoin"
              : account.chain === "BCH"
                ? "bitcoin_cash"
                : "dogecoin",
        }).getWalletPublicKey(path, {
          verify: checkOnDevice,
          format: account.path.startsWith("m/84'") ? "bech32" : "legacy",
        });
        publicKey = getBytes(
          SigningKey.computePublicKey(`0x${result.publicKey}`, true)
        );
        displayed = result.bitcoinAddress;
      } else
        throw new ConnectError(
          ERROR_CODES.unsupported,
          "This Ledger app does not support address registration."
        );
    }
    const address = addressFor(
      account.chain,
      publicKey,
      account.path,
      account.scheme
    );
    const expectedDisplay =
      account.scheme === "eip712"
        ? addressFor("ETH", publicKey, account.path)
        : address;
    if (
      displayed.toLowerCase().replace(/^bitcoincash:/, "") !==
      expectedDisplay.toLowerCase().replace(/^bitcoincash:/, "")
    )
      throw new ConnectError(
        ERROR_CODES.invalid,
        "The device address does not match its public key"
      );
    return { ...account, address, publicKey: toHex(publicKey) };
  }

  private wallet(account: Account): DefaultWallet {
    return new DefaultWallet(
      account.path.replace(/^m\//, "").split("/").slice(0, 3).join("/"),
      account.path.startsWith("m/84'")
        ? DefaultDescriptorTemplate.NATIVE_SEGWIT
        : DefaultDescriptorTemplate.LEGACY
    );
  }

  async sign(
    account: Account,
    request: SignRequest,
    deviceId?: string
  ): Promise<unknown> {
    validateSignAccount(account, request);
    if (request.method === "signMoneroTransaction")
      validateMoneroTransaction(account, request.params);
    const verified = await this.register(account, deviceId);
    if (
      verified.account.publicKey !== account.publicKey ||
      verified.account.address !== account.address
    )
      throw new ConnectError(
        ERROR_CODES.unauthorized,
        "Connect the Ledger used to register this account"
      );
    const activeDeviceId = verified.deviceId;
    if (request.method === "signMoneroTransaction") {
      try {
        return await signLedgerMonero(
          account,
          request.params,
          (apdu, abortTimeout) => this.moneroExchange(apdu, abortTimeout)
        );
      } finally {
        await this.disconnect();
      }
    }
    const sessionId = await this.session(activeDeviceId);
    const path = account.path.replace(/^m\//, "");
    switch (request.method) {
      case "eth_signTransaction": {
        const tx = evmTransaction(request.params);
        const signature = await complete(
          new SignerEthBuilder({ dmk: this.dmk, sessionId })
            .withContextModule(offlineContext)
            .build()
            .signTransaction(path, getBytes(tx.unsignedSerialized))
        );
        tx.signature = Signature.from(signature);
        return tx.serialized;
      }
      case "personal_sign":
        return Signature.from(
          await complete(
            new SignerEthBuilder({ dmk: this.dmk, sessionId })
              .withContextModule(offlineContext)
              .build()
              .signMessage(path, fromHex(request.params.message))
          )
        ).serialized;
      case "eth_signTypedData_v4": {
        const data = typedData(request.params);
        const domain = {
          ...(typeof data.domain.name === "string"
            ? { name: data.domain.name }
            : {}),
          ...(typeof data.domain.version === "string"
            ? { version: data.domain.version }
            : {}),
          ...(typeof data.domain.verifyingContract === "string"
            ? { verifyingContract: data.domain.verifyingContract }
            : {}),
          ...(typeof data.domain.salt === "string"
            ? { salt: data.domain.salt }
            : {}),
          ...(data.domain.chainId == null
            ? {}
            : { chainId: Number(data.domain.chainId) }),
        };
        return Signature.from(
          await complete(
            new SignerEthBuilder({ dmk: this.dmk, sessionId })
              .withContextModule(offlineContext)
              .build()
              .signTypedData(path, {
                domain,
                types: data.types,
                message: data.message,
                primaryType: data.primaryType,
              })
          )
        ).serialized;
      }
      case "signAmino": {
        const transport = await this.protocol(account, activeDeviceId);
        const result =
          account.chain === "THOR"
            ? await new THORChainApp(transport).sign(
                pathNumbers(account.path),
                canonicalJson(request.params)
              )
            : await new Cosmos(transport)
                .sign(path, canonicalJson(request.params))
                .catch((error: unknown) => {
                  throw ledgerError(error);
                });
        if (!result.signature)
          throw new ConnectError(
            ERROR_CODES.rejected,
            "Ledger declined the Amino signature"
          );
        const compact = secp256k1.Signature.fromBytes(
          result.signature,
          "der"
        ).toBytes("compact");
        return {
          signed: request.params,
          signature: {
            pub_key: {
              type: "tendermint/PubKeySecp256k1",
              value: base64(fromHex(account.publicKey ?? "")),
            },
            signature: base64(compact),
          },
        };
      }
      case "signPsbt": {
        if (account.chain !== "BTC")
          throw new ConnectError(
            ERROR_CODES.unsupported,
            "Use native transaction signing for this Ledger app"
          );
        const psbt = validatePsbt(account, request);
        const signer = new SignerBtcBuilder({
          dmk: this.dmk,
          sessionId,
        }).build();
        const fingerprint = await complete(signer.getMasterFingerprint());
        for (const index of request.params.inputs)
          psbt.updateInput(index, {
            bip32Derivation: [
              {
                masterFingerprint: Buffer.from(fingerprint.masterFingerprint),
                path: account.path,
                pubkey: Buffer.from(fromHex(account.publicKey ?? "")),
              },
            ],
          });
        for (const signature of await complete(
          signer.signPsbt(this.wallet(account), psbt.toBase64())
        ))
          if (
            "pubkey" in signature &&
            "signature" in signature &&
            request.params.inputs.includes(signature.inputIndex) &&
            toHex(signature.pubkey) === account.publicKey
          )
            psbt.updateInput(signature.inputIndex, {
              partialSig: [
                {
                  pubkey: Buffer.from(signature.pubkey),
                  signature: Buffer.from(signature.signature),
                },
              ],
            });
        return { psbt: psbt.toBase64() };
      }
      case "signUtxoTransaction": {
        const tx = validateUtxo(account, request);
        if (account.chain === "BTC") {
          const psbt = new Psbt({ network: utxoNetwork(account.chain) })
            .setVersion(tx.version)
            .setLocktime(tx.locktime);
          for (let index = 0; index < tx.ins.length; index++) {
            const input = tx.ins[index];
            const previous = request.params.inputs.find(
              (entry) => entry.index === index
            );
            if (!input || !previous)
              throw new ConnectError(
                ERROR_CODES.invalid,
                "Missing previous transaction"
              );
            psbt.addInput({
              hash: input.hash,
              index: input.index,
              sequence: input.sequence,
              nonWitnessUtxo: Buffer.from(
                fromHex(previous.previousTransactionHex)
              ),
            });
          }
          for (const output of tx.outs) psbt.addOutput(output);
          const result = await this.sign(
            account,
            {
              accountId: account.id,
              chain: account.chain,
              method: "signPsbt",
              params: {
                psbt: psbt.toBase64(),
                inputs: request.params.inputs.map((entry) => entry.index),
              },
            },
            activeDeviceId
          );
          const parsed = Psbt.fromBase64((result as { psbt: string }).psbt);
          parsed.finalizeAllInputs();
          return { transactionHex: parsed.extractTransaction().toHex() };
        }
        const btc = new Btc({
          transport: await this.protocol(account, activeDeviceId),
          currency:
            account.chain === "LTC"
              ? "litecoin"
              : account.chain === "BCH"
                ? "bitcoin_cash"
                : "dogecoin",
        });
        const inputs = request.params.inputs
          .toSorted((a, b) => a.index - b.index)
          .map(
            (
              entry
            ): [
              ReturnType<Btc["splitTransaction"]>,
              number,
              undefined,
              number,
            ] => {
              const input = tx.ins[entry.index];
              if (!input)
                throw new ConnectError(
                  ERROR_CODES.invalid,
                  "Invalid input index"
                );
              return [
                btc.splitTransaction(entry.previousTransactionHex, false),
                input.index,
                undefined,
                input.sequence,
              ];
            }
          );
        const unsigned = btc.splitTransaction(
          tx.toHex(),
          account.path.startsWith("m/84'")
        );
        const signed = await btc.createPaymentTransaction({
          inputs,
          associatedKeysets: inputs.map(() => path),
          outputScriptHex: btc
            .serializeTransactionOutputs(unsigned)
            .toString("hex"),
          lockTime: tx.locktime,
          sigHashType: account.chain === "BCH" ? 0x41 : 1,
          segwit: account.path.startsWith("m/84'"),
          additionals:
            account.chain === "BCH"
              ? ["abc"]
              : account.path.startsWith("m/84'")
                ? ["bech32"]
                : [],
        });
        return { transactionHex: signed };
      }
      case "signSolanaTransaction": {
        const tx = solanaTransaction(account, request.params.transaction);
        const signature = await complete(
          new SignerSolanaBuilder({ dmk: this.dmk, sessionId })
            .withContextModule(offlineContext)
            .build()
            .signTransaction(path, tx.serialize())
        );
        tx.addSignature(new PublicKey(account.address), signature);
        return { transaction: base64(tx.serialize()) };
      }
      case "signSolanaMessage":
        return {
          signature: base64(
            fromHex(
              (
                await complete(
                  new SignerSolanaBuilder({ dmk: this.dmk, sessionId })
                    .withContextModule(offlineContext)
                    .build()
                    .signMessage(path, fromHex(request.params.message))
                )
              ).signature
            )
          ),
        };
      case "signXrpTransaction": {
        validate(request.params);
        const tx = {
          ...request.params,
          SigningPubKey: account.publicKey?.toUpperCase(),
        };
        const signature = await new Xrp(
          await this.protocol(account, activeDeviceId)
        ).signTransaction(path, encode(tx as XrpTransaction));
        return {
          tx_blob: encode({ ...tx, TxnSignature: signature } as XrpTransaction),
        };
      }
      case "signTronTransaction": {
        const tx = validateTron(account, request.params);
        const signature = await new Trx(
          await this.protocol(account, activeDeviceId)
        ).signTransaction(path, tx.rawDataHex, []);
        return { ...request.params, signature: [signature] };
      }
      case "signDirect":
        throw new ConnectError(
          ERROR_CODES.unsupported,
          "This Ledger app supports Amino signing"
        );
    }
  }
}
