import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";


const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
