import doge from "./assets/doge.png";
import monero from "./assets/monero.png";
import thor from "./assets/thor.svg";
import {
  Avalanche,
  Base,
  BinanceSmartChain,
  Bitcoin,
  BitcoinCash,
  Cosmos,
  Ethereum,
  Litecoin,
  Solana,
  Tron,
  XRP,
} from "./NetworkIcons";

import type { Chain } from "@rujira/connect-core";
import type { ReactElement } from "react";

const icons = {
  AVAX: Avalanche,
  BASE: Base,
  BSC: BinanceSmartChain,
  BTC: Bitcoin,
  BCH: BitcoinCash,
  ETH: Ethereum,
  GAIA: Cosmos,
  LTC: Litecoin,
  SOL: Solana,
  TRON: Tron,
  XRP,
};

export function NetworkIcon({
  chain,
}: {
  readonly chain: Chain;
}): ReactElement {
  let artwork: ReactElement;
  switch (chain) {
    case "THOR":
    case "DOGE":
    case "XMR":
      artwork = (
        <img src={{ THOR: thor, DOGE: doge, XMR: monero }[chain]} alt="" />
      );
      break;
    case "AVAX":
    case "BASE":
    case "BSC":
    case "BTC":
    case "BCH":
    case "ETH":
    case "GAIA":
    case "LTC":
    case "SOL":
    case "TRON":
    case "XRP": {
      const Icon = icons[chain];
      artwork = <Icon />;
    }
  }
  return (
    <span className="network-icon" data-network={chain} aria-hidden="true">
      {artwork}
    </span>
  );
}
