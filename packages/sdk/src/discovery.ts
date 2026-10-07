import { CONNECT_ICON_SVG } from "./icon";
import { BrowserRujiraProvider, CosmosProvider, EvmProvider } from "./provider";
import { registerSolanaWallet } from "./solana";

import type { RujiraProvider } from "./provider";

const ICON = `data:image/svg+xml,${encodeURIComponent(CONNECT_ICON_SVG)}`;

export function installProvider(target: Window): RujiraProvider {
  if (target.rujira) return target.rujira;
  const bridge = new BrowserRujiraProvider(target);
  const ethereum = new EvmProvider(bridge);
  const cosmos = new CosmosProvider(bridge);
  Object.defineProperty(target, "rujira", {
    value: Object.assign(bridge, { ethereum, cosmos }),
    configurable: false,
    writable: false,
  });
  const detail = Object.freeze({
    info: Object.freeze({
      uuid: crypto.randomUUID(),
      name: "Rujira Connect",
      rdns: "network.rujira.connect",
      icon: ICON,
    }),
    provider: ethereum,
  });
  const announce = (): void => {
    target.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail })
    );
  };
  target.addEventListener("eip6963:requestProvider", announce);
  announce();
  registerSolanaWallet(bridge, CONNECT_ICON_SVG);
  return bridge;
}

export function getRujira(): RujiraProvider {
  if (!window.rujira)
    throw new Error("Install Rujira Connect to connect a signing account");
  return window.rujira;
}
