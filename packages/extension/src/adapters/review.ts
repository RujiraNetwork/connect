import {
  CHAINS,
  canonicalJson,
  isDefaultAccountPath,
} from "@rujira/connect-core";
import { formatUnits } from "ethers";

import { fromHex } from "./bytes";
import { recipient, validateMoneroTransaction } from "./monero-transactions";
import { thorTypedData } from "./thor-eip712";
import {
  outputAddress,
  solanaTransaction,
  typedData,
  validatePsbt,
  validateTron,
  validateUtxo,
} from "./transactions";

import type { Account, PendingView, SignRequest } from "@rujira/connect-core";

export function reviewRequest(
  account: Account,
  request: SignRequest
): NonNullable<PendingView["review"]> {
  const chain = CHAINS[account.chain];
  const fields: { label: string; value: string }[] = [
    { label: "Network", value: chain.name },
    { label: "Signing account", value: account.address },
  ];
  if (!isDefaultAccountPath(account))
    fields.push({ label: "HD path", value: account.path });
  let rawRequired = true;
  switch (request.method) {
    case "eth_signTransaction": {
      const tx = request.params;
      fields.push(
        { label: "Recipient", value: tx.to ?? "Contract deployment" },
        {
          label: "Amount",
          value: `${formatUnits(tx.value ?? "0", chain.decimals)} ${chain.symbol}`,
        },
        {
          label: "Maximum fee",
          value: `${formatUnits(BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas ?? tx.gasPrice ?? "0"), chain.decimals)} ${chain.symbol}`,
        }
      );
      rawRequired =
        tx.to === undefined ||
        (tx.data !== undefined && fromHex(tx.data).length > 0);
      break;
    }
    case "personal_sign":
    case "signSolanaMessage": {
      let message: string;
      try {
        message = new TextDecoder("utf-8", { fatal: true }).decode(
          fromHex(request.params.message)
        );
        rawRequired = Array.from(message).some((character) => {
          const code = character.codePointAt(0) ?? 0;
          return (
            (code < 32 && code !== 9 && code !== 10) ||
            code === 127 ||
            (code >= 0x202a && code <= 0x202e) ||
            (code >= 0x2066 && code <= 0x2069)
          );
        });
      } catch {
        message = "Binary message — review the complete signing data";
        rawRequired = true;
      }
      fields.push({
        label: "Message",
        value: message,
      });
      break;
    }
    case "eth_signTypedData_v4": {
      const data = typedData(request.params);
      fields.push({ label: "Message type", value: data.primaryType });
      break;
    }
    case "signAmino":
      if (account.scheme === "eip712")
        thorTypedData(request.params, request.typedData);
      fields.push(
        { label: "Chain ID", value: request.params.chain_id },
        { label: "Memo", value: request.params.memo },
        {
          label: "Messages",
          value: request.params.msgs.map((message) => message.type).join(", "),
        }
      );
      break;
    case "signDirect":
      fields.push({ label: "Chain ID", value: request.params.chainId });
      break;
    case "signPsbt": {
      const psbt = validatePsbt(account, request);
      for (const [index, output] of psbt.txOutputs.entries())
        fields.push({
          label: `Output ${String(index + 1)}`,
          value: `${formatUnits(output.value, chain.decimals)} ${chain.symbol} → ${output.address ?? outputAddress(output.script, account.chain)}`,
        });
      fields.push({
        label: "Inputs to sign",
        value: request.params.inputs.map(String).join(", "),
      });
      break;
    }
    case "signUtxoTransaction": {
      const tx = validateUtxo(account, request);
      for (const [index, output] of tx.outs.entries())
        fields.push({
          label: `Output ${String(index + 1)}`,
          value: `${formatUnits(output.value, chain.decimals)} ${chain.symbol} → ${outputAddress(output.script, account.chain)}`,
        });
      if (request.params.inputs.length !== tx.ins.length) {
        fields.push({
          label: "Fee",
          value:
            "This request includes only some inputs. Check the full transaction in the app for its fee.",
        });
        break;
      }
      const fee =
        request.params.inputs.reduce(
          (sum, input) => sum + BigInt(input.value),
          0n
        ) - tx.outs.reduce((sum, output) => sum + BigInt(output.value), 0n);
      if (fee < 0n) throw new Error("Transaction outputs exceed inputs");
      fields.push({
        label: "Fee",
        value: `${formatUnits(fee, chain.decimals)} ${chain.symbol}`,
      });
      break;
    }
    case "signSolanaTransaction": {
      const tx = solanaTransaction(account, request.params.transaction);
      fields.push({
        label: "Recent blockhash",
        value: tx.message.recentBlockhash,
      });
      break;
    }
    case "signXrpTransaction":
      fields.push(
        {
          label: "Transaction type",
          value: String(request.params.TransactionType),
        },
        {
          label: "Recipient",
          value: canonicalJson(request.params.Destination ?? "—"),
        },
        { label: "Amount", value: canonicalJson(request.params.Amount ?? "0") }
      );
      break;
    case "signTronTransaction":
      validateTron(account, request.params);
      break;
    case "signMoneroTransaction": {
      validateMoneroTransaction(account, request.params);
      const destination = recipient(request.params);
      fields.push(
        { label: "Recipient", value: destination.original },
        {
          label: "Amount",
          value: `${formatUnits(destination.amount, 12)} XMR`,
        },
        {
          label: "Fee",
          value: `${formatUnits(request.params.tsx_data.fee, 12)} XMR`,
        },
        {
          label: "Change",
          value: `${formatUnits(request.params.tsx_data.change_dts.amount, 12)} XMR → ${account.address}`,
        }
      );
      rawRequired = false;
      break;
    }
  }
  return {
    title:
      request.method === "personal_sign" ||
      request.method === "signSolanaMessage"
        ? "Sign message"
        : "Review signing request",
    fields,
    raw: canonicalJson(
      request.method === "signAmino" && request.typedData
        ? { signDoc: request.params, typedData: request.typedData }
        : request.params
    ),
    requiresRawAcknowledgement: rawRequired,
  };
}
