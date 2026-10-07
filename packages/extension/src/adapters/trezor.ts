import { Buffer } from "buffer";

import {
  CHAINS,
  ConnectError,
  ERROR_CODES,
  validateSignAccount,
} from "@rujira/connect-core";
import { PublicKey } from "@solana/web3.js";
import TrezorConnect, {
  UI_REQUEST,
  UI_REQUESTS,
  UI_RESPONSE,
} from "@trezor/connect-core";
import { AbstractApiTransport, UsbApi } from "@trezor/transport-common";
import { address as bitcoinAddress, Transaction, script } from "bitcoinjs-lib";
import cashaddr from "cashaddrjs";
import { Signature, SigningKey, getBytes } from "ethers";
import { z } from "zod";

import { base64, fromHex, toHex } from "./bytes";
import { addressFor, utxoNetwork } from "./keys";
import { pathNumbers } from "./ledger";
import { moneroPublicKeys } from "./monero-keys";
import {
  evmTransaction,
  solanaTransaction,
  typedData,
  validatePsbt,
  validateTron,
  validateUtxo,
} from "./transactions";

import type {
  Account,
  SignRequest,
  DevicePrompt,
  UiRequest,
} from "@rujira/connect-core";
import type {
  RefTransaction,
  TronSignTransaction,
  EthereumSignTypedDataTypes,
  SignTransaction as TrezorSignTransaction,
  UiRequestMessage,
} from "@trezor/connect-core";

function result<T>(
  response: { success: true; payload: T } | { success: false }
): T {
  if (!response.success)
    throw new ConnectError(
      ERROR_CODES.rejected,
      "The Trezor request was cancelled or unsupported. Unlock your device, check its screen, and try again."
    );
  return response.payload;
}

function utxoCoin(chain: Account["chain"]): "btc" | "ltc" | "bch" | "doge" {
  if (chain === "BTC") return "btc";
  if (chain === "LTC") return "ltc";
  if (chain === "BCH") return "bch";
  if (chain === "DOGE") return "doge";
  throw new ConnectError(ERROR_CODES.unsupported, "Not a UTXO chain");
}

/** Direct USB with in-memory session coordination; no Bridge or remote worker. */
class OfflineUsbTransport extends AbstractApiTransport {
  readonly name = "WebUsbTransport";
  constructor() {
    const usb = (
      navigator as Navigator & {
        usb: ConstructorParameters<typeof UsbApi>[0]["usbInterface"];
      }
    ).usb;
    super({ id: "rujira-connect", api: new UsbApi({ usbInterface: usb }) });
  }
}

export class TrezorAdapter {
  private ready: Promise<void> | undefined;
  prompt: DevicePrompt | undefined;
  async deviceInfo(): Promise<{ deviceId?: string; deviceName: string }> {
    const features = result(await TrezorConnect.getFeatures());
    const models: Record<string, string> = {
      T1B1: "Trezor Model One",
      T2T1: "Trezor Model T",
      T2B1: "Trezor Safe 3",
      T3B1: "Trezor Safe 3",
      T3T1: "Trezor Safe 5",
      T3W1: "Trezor Safe 7",
    };
    return {
      ...(features.device_id ? { deviceId: features.device_id } : {}),
      deviceName:
        models[features.internal_model] ??
        (features.model === "1"
          ? "Trezor Model One"
          : features.model === "T"
            ? "Trezor Model T"
            : "Trezor"),
    };
  }
  private receivePrompt = (request: UiRequestMessage): void => {
    const { requestId: id } = request;
    switch (request.type) {
      case UI_REQUESTS.REQUEST_PIN:
        this.prompt = {
          id,
          kind: "pin",
          message:
            "Use the positions shown on your Trezor's PIN grid. 1 is bottom left; 9 is top right.",
        };
        break;
      case UI_REQUESTS.REQUEST_PASSPHRASE:
        this.prompt = {
          id,
          kind: "passphrase",
          message:
            "Enter your wallet passphrase, or leave it empty for your standard wallet.",
        };
        break;
      case UI_REQUESTS.REQUEST_THP_PAIRING_TAG:
        this.prompt = {
          id,
          kind: "pairing",
          message: "Enter the pairing code shown on your Trezor.",
        };
        break;
      case UI_REQUESTS.REQUEST_CONFIRMATION:
        this.prompt = {
          id,
          kind: "confirmation",
          message:
            request.payload.view === "export-xpub"
              ? "Allow this device to share the public key for your account?"
              : request.payload.view === "export-address"
                ? "Allow this device to share your address?"
                : "Confirm this connection on your Trezor, then continue here.",
        };
        break;
      case UI_REQUESTS.REQUEST_ACCOUNT:
      case UI_REQUESTS.REQUEST_FEE:
      case UI_REQUESTS.REQUEST_WORD:
      case UI_REQUESTS.REQUEST_DISCOVERY_ACCOUNTS:
        TrezorConnect.cancel({
          reason: "This device flow is unavailable in an offline signer.",
        });
        break;
    }
  };
  respond(response: Extract<UiRequest, { action: "deviceResponse" }>): void {
    const prompt = this.prompt;
    if (prompt?.id !== response.id)
      throw new ConnectError(
        ERROR_CODES.expired,
        "This device prompt has expired. Try connecting again."
      );
    if (response.cancel) {
      TrezorConnect.cancel({ reason: "You cancelled the device request." });
    } else if (prompt.kind === "pin") {
      if (!/^[1-9]{1,50}$/.test(response.value))
        throw new ConnectError(
          ERROR_CODES.invalid,
          "Enter PIN grid positions from 1 to 9."
        );
      TrezorConnect.uiResponse({
        requestId: prompt.id,
        type: UI_RESPONSE.RECEIVE_PIN,
        payload: response.value,
      });
    } else if (prompt.kind === "passphrase") {
      TrezorConnect.uiResponse({
        requestId: prompt.id,
        type: UI_RESPONSE.RECEIVE_PASSPHRASE,
        payload: {
          value: response.value,
          passphraseOnDevice: response.onDevice,
          save: false,
        },
      });
    } else if (prompt.kind === "pairing") {
      TrezorConnect.uiResponse({
        requestId: prompt.id,
        type: UI_RESPONSE.RECEIVE_THP_PAIRING_TAG,
        payload: { tag: response.value },
      });
    } else {
      TrezorConnect.uiResponse({
        requestId: prompt.id,
        type: UI_RESPONSE.RECEIVE_CONFIRMATION,
        payload: true,
      });
    }
    this.prompt = undefined;
  }
  disconnect(): void {
    if (this.ready) TrezorConnect.dispose();
    this.ready = undefined;
    this.prompt = undefined;
  }
  private init(): Promise<void> {
    if (!this.ready) {
      TrezorConnect.on(UI_REQUEST, this.receivePrompt);
      this.ready = TrezorConnect.init({
        manifest: {
          email: "support@rujira.network",
          appName: "Rujira Connect",
          appUrl: "https://rujira.network",
        },
        // Connect's vendored declaration duplicates this same transport's protected fields.
        transports: [
          new OfflineUsbTransport() as unknown as NonNullable<
            NonNullable<Parameters<typeof TrezorConnect.init>[0]>["transports"]
          >[number],
        ],
        enableFirmwareHashCheck: false,
        thp: { appName: "Rujira Connect", pairingMethods: ["CodeEntry"] },
      }).catch((error: unknown) => {
        this.disconnect();
        throw error;
      });
    }
    return this.ready;
  }

  async register(account: Account): Promise<Account> {
    await this.init();
    let address: string;
    let publicKey: string | undefined;
    if (CHAINS[account.chain].family === "evm" || account.scheme === "eip712") {
      const displayed = result(
        await TrezorConnect.ethereumGetAddress({
          path: account.path,
          showOnTrezor: true,
        })
      );
      const node = result(
        await TrezorConnect.ethereumGetPublicKey({ path: account.path })
      );
      publicKey = toHex(
        getBytes(SigningKey.computePublicKey(`0x${node.publicKey}`, true))
      );
      if (
        addressFor("ETH", fromHex(publicKey), account.path).toLowerCase() !==
        displayed.address.toLowerCase()
      )
        throw new ConnectError(
          ERROR_CODES.invalid,
          "Trezor public key does not match its displayed address"
        );
      address = addressFor(
        account.chain,
        fromHex(publicKey),
        account.path,
        account.scheme
      );
    } else if (CHAINS[account.chain].family === "utxo") {
      const coin = utxoCoin(account.chain);
      address = result(
        await TrezorConnect.getAddress({
          path: account.path,
          coin,
          showOnTrezor: true,
        })
      ).address;
      publicKey = result(
        await TrezorConnect.getPublicKey({ path: account.path, coin })
      ).publicKey;
      address = address.replace(/^bitcoincash:/, "");
      if (
        addressFor(account.chain, fromHex(publicKey), account.path).replace(
          /^bitcoincash:/,
          ""
        ) !== address
      )
        throw new ConnectError(
          ERROR_CODES.invalid,
          "Trezor public key does not match its displayed address"
        );
      if (account.chain === "BCH") address = `bitcoincash:${address}`;
    } else if (account.chain === "SOL") {
      address = result(
        await TrezorConnect.solanaGetAddress({
          path: account.path,
          showOnTrezor: true,
        })
      ).address;
      publicKey = result(
        await TrezorConnect.solanaGetPublicKey({ path: account.path })
      ).publicKey;
      if (addressFor("SOL", fromHex(publicKey), account.path) !== address)
        throw new ConnectError(
          ERROR_CODES.invalid,
          "Trezor public key does not match its displayed address"
        );
    } else if (account.chain === "XMR") {
      address = result(
        await TrezorConnect.moneroGetAddress({
          path: account.path,
          showOnTrezor: true,
        })
      ).address;
      publicKey = moneroPublicKeys(address).publicKey;
    } else if (account.chain === "XRP")
      address = result(
        await TrezorConnect.rippleGetAddress({
          path: account.path,
          showOnTrezor: true,
        })
      ).address;
    else if (account.chain === "TRON")
      address = result(
        await TrezorConnect.tronGetAddress({
          path: account.path,
          showOnTrezor: true,
        })
      ).address;
    else
      throw new ConnectError(
        ERROR_CODES.unsupported,
        "Choose the Ethereum app profile for THORChain. This Trezor signer does not support Cosmos Hub."
      );
    return {
      ...account,
      address,
      ...(publicKey === undefined
        ? {}
        : { publicKey: toHex(fromHex(publicKey)) }),
    };
  }

  async sign(account: Account, request: SignRequest): Promise<unknown> {
    validateSignAccount(account, request);
    await this.init();
    const verified = await this.register(account);
    if (
      verified.address !== account.address ||
      verified.publicKey !== account.publicKey
    )
      throw new ConnectError(
        ERROR_CODES.unauthorized,
        "Connect the Trezor used to register this account"
      );
    switch (request.method) {
      case "eth_signTransaction": {
        const tx = evmTransaction(request.params);
        if (request.params.accessList?.length)
          throw new ConnectError(
            ERROR_CODES.unsupported,
            "This Trezor adapter does not support access-list transactions"
          );
        const common = {
          to: tx.to,
          value: tx.value.toString(16),
          gasLimit: tx.gasLimit.toString(16),
          nonce: tx.nonce.toString(16),
          data: toHex(getBytes(tx.data)),
          chainId: Number(tx.chainId),
        };
        const transaction =
          tx.type === 2
            ? {
                ...common,
                maxFeePerGas: (tx.maxFeePerGas ?? 0n).toString(16),
                maxPriorityFeePerGas: (tx.maxPriorityFeePerGas ?? 0n).toString(
                  16
                ),
              }
            : { ...common, gasPrice: (tx.gasPrice ?? 0n).toString(16) };
        const signature = result(
          await TrezorConnect.ethereumSignTransaction({
            path: account.path,
            transaction,
          })
        );
        tx.signature = Signature.from({
          r: `0x${signature.r}`,
          s: `0x${signature.s}`,
          v: Number(BigInt(`0x${signature.v}`)),
        });
        return tx.serialized;
      }
      case "personal_sign":
        return `0x${result(await TrezorConnect.ethereumSignMessage({ path: account.path, message: toHex(fromHex(request.params.message)), hex: true })).signature}`;
      case "eth_signTypedData_v4": {
        const data = typedData(request.params);
        const payload = result(
          await TrezorConnect.ethereumSignTypedData<EthereumSignTypedDataTypes>(
            {
              path: account.path,
              metamask_v4_compat: true,
              data: {
                primaryType: data.primaryType,
                message: data.message,
                domain: request.params.domain,
                types: {
                  ...data.types,
                },
              },
            }
          )
        );
        return `0x${toHex(fromHex(payload.signature))}`;
      }
      case "signUtxoTransaction":
        return this.signUtxo(account, request);
      case "signPsbt": {
        const psbt = validatePsbt(account, request);
        if (request.params.inputs.length !== psbt.inputCount)
          throw new ConnectError(
            ERROR_CODES.unsupported,
            "Trezor PSBT signing currently requires all inputs to belong to the registered account"
          );
        const tx = new Transaction();
        tx.version = psbt.version;
        tx.locktime = psbt.locktime;
        const inputs = psbt.txInputs.map((input, index) => {
          const previous = psbt.data.inputs[index]?.nonWitnessUtxo;
          if (!previous)
            throw new ConnectError(
              ERROR_CODES.invalid,
              "Trezor requires complete previous transactions in the PSBT"
            );
          tx.addInput(input.hash, input.index, input.sequence);
          const output = Transaction.fromBuffer(previous).outs[input.index];
          if (!output)
            throw new ConnectError(
              ERROR_CODES.invalid,
              "Missing previous output"
            );
          return {
            index,
            previousTransactionHex: previous.toString("hex"),
            value: String(output.value),
          };
        });
        for (const output of psbt.txOutputs)
          tx.addOutput(output.script, output.value);
        const signed = await this.signUtxo(account, {
          accountId: account.id,
          chain: account.chain,
          method: "signUtxoTransaction",
          params: { transactionHex: tx.toHex(), inputs },
        });
        signed.signatures.forEach((signature, index) =>
          psbt.updateInput(index, {
            partialSig: [
              {
                pubkey: Buffer.from(fromHex(account.publicKey ?? "")),
                signature: Buffer.concat([
                  Buffer.from(fromHex(signature)),
                  Buffer.from([1]),
                ]),
              },
            ],
          })
        );
        return { psbt: psbt.toBase64() };
      }
      case "signSolanaTransaction": {
        const tx = solanaTransaction(account, request.params.transaction);
        const signature = result(
          await TrezorConnect.solanaSignTransaction({
            path: account.path,
            serializedTx: toHex(tx.message.serialize()),
          })
        ).signature;
        tx.addSignature(new PublicKey(account.address), fromHex(signature));
        return { transaction: base64(tx.serialize()) };
      }
      case "signSolanaMessage":
        return {
          signature: base64(
            fromHex(
              result(
                await TrezorConnect.solanaSignMessage({
                  path: account.path,
                  message: toHex(fromHex(request.params.message)),
                })
              ).signature
            )
          ),
        };
      case "signXrpTransaction": {
        const tx = z
          .object({
            TransactionType: z.literal("Payment"),
            Account: z.string(),
            Destination: z.string(),
            Amount: z.string().regex(/^\d+$/),
            Fee: z.string().regex(/^\d+$/),
            Sequence: z.number().int().nonnegative(),
            Flags: z.number().int().optional(),
            DestinationTag: z.number().int().optional(),
            LastLedgerSequence: z.number().int().optional(),
          })
          .strict()
          .parse(request.params);
        const response = result(
          await TrezorConnect.rippleSignTransaction({
            path: account.path,
            transaction: {
              fee: tx.Fee,
              sequence: tx.Sequence,
              ...(tx.Flags === undefined ? {} : { flags: tx.Flags }),
              ...(tx.LastLedgerSequence === undefined
                ? {}
                : { maxLedgerVersion: tx.LastLedgerSequence }),
              payment: {
                amount: tx.Amount,
                destination: tx.Destination,
                ...(tx.DestinationTag === undefined
                  ? {}
                  : { destinationTag: tx.DestinationTag }),
              },
            },
          })
        );
        return { tx_blob: response.serializedTx };
      }
      case "signTronTransaction": {
        validateTron(account, request.params);
        const raw = z
          .object({
            ref_block_bytes: z.string(),
            ref_block_hash: z.string(),
            expiration: z.number().int().safe(),
            timestamp: z.number().int().safe(),
            contract: z.array(z.record(z.unknown())),
            fee_limit: z.number().int().safe().optional(),
            data: z.string().optional(),
          })
          .strict()
          .parse(request.params.raw_data);
        // The native bytes and every owner were checked by validateTron; the SDK validates supported contract variants.
        const native = { path: account.path, ...raw } as TronSignTransaction;
        const signature = result(
          await TrezorConnect.tronSignTransaction(native)
        ).signature;
        return { ...request.params, signature: [signature] };
      }
      case "signAmino":
      case "signDirect":
        throw new ConnectError(
          ERROR_CODES.unsupported,
          "This Trezor account has no native Cosmos signer"
        );
      case "signMoneroTransfer":
        throw new ConnectError(
          ERROR_CODES.unsupported,
          "Monero signing uses the companion"
        );
    }
  }

  private async signUtxo(
    account: Account,
    request: Extract<SignRequest, { method: "signUtxoTransaction" }>
  ): Promise<{ transactionHex: string; signatures: string[] }> {
    const tx = validateUtxo(account, request);
    const previous = request.params.inputs
      .toSorted((a, b) => a.index - b.index)
      .map((entry) => Transaction.fromHex(entry.previousTransactionHex));
    const refTxs: RefTransaction[] = previous.map((entry) => ({
      hash: entry.getId(),
      version: entry.version,
      lock_time: entry.locktime,
      inputs: entry.ins.map((input) => ({
        prev_hash: Buffer.from(input.hash).reverse().toString("hex"),
        prev_index: input.index,
        script_sig: input.script.toString("hex"),
        sequence: input.sequence,
      })),
      bin_outputs: entry.outs.map((output) => ({
        amount: String(output.value),
        script_pubkey: output.script.toString("hex"),
      })),
    }));
    const inputs = tx.ins.map((input, index) => ({
      address_n: pathNumbers(account.path),
      prev_hash: Buffer.from(input.hash).reverse().toString("hex"),
      prev_index: input.index,
      amount:
        request.params.inputs.find((entry) => entry.index === index)?.value ??
        "0",
      sequence: input.sequence,
      script_type: account.path.startsWith("m/84'")
        ? ("SPENDWITNESS" as const)
        : ("SPENDADDRESS" as const),
    }));
    const outputs = tx.outs.map(
      (output): TrezorSignTransaction["outputs"][number] => {
        const chunks = script.decompile(output.script);
        if (
          chunks?.[0] === 0x6a &&
          chunks.length === 2 &&
          Buffer.isBuffer(chunks[1]) &&
          output.value === 0
        )
          return {
            amount: "0",
            script_type: "PAYTOOPRETURN" as const,
            op_return_data: chunks[1].toString("hex"),
          };
        let address = bitcoinAddress.fromOutputScript(
          output.script,
          utxoNetwork(account.chain)
        );
        if (account.chain === "BCH") {
          const decoded = bitcoinAddress.fromBase58Check(address);
          address = cashaddr.encode(
            "bitcoincash",
            decoded.version === 0 ? "P2PKH" : "P2SH",
            decoded.hash
          );
        }
        return {
          address,
          amount: String(output.value),
          script_type: "PAYTOADDRESS" as const,
        };
      }
    );
    const response = result(
      await TrezorConnect.signTransaction({
        coin: utxoCoin(account.chain),
        inputs,
        outputs,
        refTxs,
        version: tx.version,
        locktime: tx.locktime,
        push: false,
      })
    );
    return {
      transactionHex: response.serializedTx,
      signatures: response.signatures,
    };
  }
}
