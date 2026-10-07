import { getRujira, signRequestSchema } from "@rujira/connect";
import { CHAIN_IDS, CHAINS } from "@rujira/connect-core";
import { JsonRpcProvider } from "ethers";

import "./style.css";

import type { PublicAccount } from "@rujira/connect-core";

function element<T extends HTMLElement>(
  id: string,
  type: new (...args: never[]) => T
): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Missing ${id}`);
  return node;
}
const output = element("output", HTMLPreElement);
const select = element("account", HTMLSelectElement);
let accounts: PublicAccount[] = [];
function action(id: string, handler: () => Promise<unknown>): void {
  const button = element(id, HTMLButtonElement);
  button.addEventListener("click", () => {
    button.disabled = true;
    handler()
      .then((value) => {
        output.textContent = JSON.stringify(value, null, 2);
      })
      .catch((error: unknown) => {
        output.textContent =
          error instanceof Error ? error.message : "Request failed";
      })
      .finally(() => {
        button.disabled = false;
      })
      .catch(() => {
        /* This best-effort notification has no user-visible result. */
      });
  });
}
function selected(): PublicAccount {
  const account = accounts.find((entry) => entry.id === select.value);
  if (!account) throw new Error("Connect and choose an account first");
  return account;
}
action("connect", async () => {
  accounts = await getRujira().connect({ chains: CHAIN_IDS });
  select.replaceChildren(
    ...accounts.map((account) => {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = `${CHAINS[account.chain].name} · ${account.address}`;
      return option;
    })
  );
  return accounts;
});
action("sign", async () => {
  const account = selected();
  const message = new TextEncoder().encode(
    element("message", HTMLTextAreaElement).value
  );
  return getRujira().request({
    accountId: account.id,
    chain: account.chain,
    method: "personal_sign",
    params: {
      message: Array.from(message, (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join(""),
    },
  });
});
action("native-sign", async () => {
  const account = selected();
  const value: unknown = JSON.parse(
    element("native", HTMLTextAreaElement).value
  );
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Provide a signing request object");
  return getRujira().request(
    signRequestSchema.parse({
      ...value,
      accountId: account.id,
      chain: account.chain,
    })
  );
});
action("broadcast", async () => {
  const url = new URL(element("rpc", HTMLInputElement).value);
  if (url.protocol !== "https:" && url.hostname !== "localhost")
    throw new Error("Use HTTPS for your RPC endpoint");
  const provider = new JsonRpcProvider(url.href);
  try {
    const tx = await provider.broadcastTransaction(
      element("transaction", HTMLTextAreaElement).value
    );
    return { transactionHash: tx.hash };
  } finally {
    provider.destroy();
  }
});
