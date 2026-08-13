import React from "react";
import { createRoot } from "react-dom/client";

import GithubApp from "./GithubApp";
import "./styles.css";


const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app");

createRoot(root).render(
  <React.StrictMode>
    <GithubApp />
  </React.StrictMode>
);
