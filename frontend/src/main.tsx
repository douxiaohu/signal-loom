import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";

import ErrorBoundary from "./components/ErrorBoundary";
import PublicApp from "./PublicApp";
const ReaderPages = lazy(() => import("./ReaderPages"));
import { SiteProvider } from "./site";
import { LanguageProvider, initializeLanguage } from "./i18n";
import { initializePublicTheme } from "./theme";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#app");
initializePublicTheme();
initializeLanguage();
const messageMatch = location.pathname.match(/^\/message\/([1-9]\d*)\/?$/);
if (!root) {
  throw new Error("Missing #app");
}

createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SiteProvider>
        <LanguageProvider>
          <Suspense fallback={<div className="boot-screen">Signal Loom…</div>}>
            {messageMatch ? (
              <ReaderPages id={messageMatch[1]} />
            ) : location.pathname === "/saved" ? (
              <ReaderPages />
            ) : (
              <PublicApp />
            )}
          </Suspense>
        </LanguageProvider>
      </SiteProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
