import { useId } from "react";

import type { ReactElement } from "react";

/** The Rujira symbol and gradient from ../ui/packages/rujira.ui/src/components/logos/RujiraLogo.tsx. */
export function Logo({
  large = false,
}: {
  readonly large?: boolean;
}): ReactElement {
  const id = useId();
  return (
    <svg
      className={large ? "logo large" : "logo"}
      viewBox="0 0 1000 1000"
      role="img"
      aria-label="Rujira">
      <defs>
        <linearGradient
          x1="97.12%"
          y1="12.295%"
          x2="15.952%"
          y2="88.858%"
          id={id}>
          <stop stopColor="#D615EB" offset="0%" />
          <stop stopColor="#8436F5" offset="100%" />
        </linearGradient>
      </defs>
      <g transform="translate(49 24)">
        <circle fill={`url(#${id})`} cx="475.5" cy="475.5" r="475.5" />
        <circle fill="#1B1821" cx="475.5" cy="475.5" r="418.489" />
        <path
          d="M460.284 232.995v159.944h-58.52l58.52 67.345h-68.973l-60.794-67.345h-45.61v67.345h-51.912V341.027h50.66l-50.66-56.12v-51.912h227.289Zm-152.396 51.912 48.766 56.12h51.718v-56.12H307.888Zm182.828 433.098v-51.912h88.39V542.628h-88.39v-51.912h227.289v51.912h-86.987v123.465h86.987v51.912H490.716Zm-257.721 0V598.748h51.912v67.345h93.716l29.75-29.155v-94.31H346.64v-51.912h113.644v166.96l-60.33 60.329H232.995Zm318.05-257.721-60.329-60.33V232.995h51.912v146.222l29.748 29.155h93.717V232.995h51.912v227.289h-166.96Z"
          fill={`url(#${id})`}
        />
      </g>
    </svg>
  );
}
