import React from "react";
import { createRoot } from "react-dom/client";

import ClickSpark from "./bits/ClickSpark";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles.css";


const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app");

createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ClickSpark>
        <App />
      </ClickSpark>
    </ErrorBoundary>
  </React.StrictMode>
);
