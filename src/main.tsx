import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./mix-api";

const host = document.getElementById("root");
if (!host) throw new Error("#root が見つかりません");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
