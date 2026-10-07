import "@fontsource/montserrat/400.css";
import "@fontsource/montserrat/600.css";
import "@fontsource/barlow-semi-condensed/400.css";
import "@fontsource/barlow-semi-condensed/600.css";
import "@fontsource/inconsolata/400.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.scss";

const container = document.getElementById("root");
if (!container) throw new Error("Missing application root");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
