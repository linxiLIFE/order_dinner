import { isIos } from "./platform.js";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles.css";

if (isIos) {
  document.documentElement.classList.add("ios-app");
  const updateViewport = () => document.documentElement.style.setProperty("--app-height", `${window.visualViewport?.height || window.innerHeight}px`);
  window.visualViewport?.addEventListener("resize", updateViewport);
  window.addEventListener("resize", updateViewport);
  updateViewport();
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
