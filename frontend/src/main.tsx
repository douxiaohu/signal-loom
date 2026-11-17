import React from "react";
import { createRoot } from "react-dom/client";

import ErrorBoundary from "./components/ErrorBoundary";
import PublicApp from "./PublicApp";
import { initializePublicTheme } from "./theme";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#app");
initializePublicTheme();
if (!root) {
  throw new Error("Missing #app");
}

createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PublicApp />
    </ErrorBoundary>
  </React.StrictMode>
);
