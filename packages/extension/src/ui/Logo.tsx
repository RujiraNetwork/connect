import connect from "./assets/connect.svg";

import type { ReactElement } from "react";

export function Logo({
  large = false,
}: {
  readonly large?: boolean;
}): ReactElement {
  return (
    <img
      className={large ? "logo large" : "logo"}
      src={connect}
      alt="Rujira Connect"
      width="300"
      height="300"
    />
  );
}
