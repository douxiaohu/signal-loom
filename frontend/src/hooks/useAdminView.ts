import { useCallback, useState } from "react";

import type { AdminView } from "../types";

export function readViewFromUrl(): AdminView {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "sources" || view === "visits" || view === "alerts" || view === "messages") return view;
  return "overview";
}

/** Which console page is open, kept in the address bar's `view` parameter. */
export function useAdminView() {
  const [view, setView] = useState<AdminView>(readViewFromUrl);

  /** Opens a page and keeps the other parameters (the message filters) as they are. */
  const changeView = useCallback((next: AdminView) => {
    const params = new URLSearchParams(window.location.search);
    if (next === "overview") params.delete("view");
    else params.set("view", next);
    const search = params.toString();
    const url = `${window.location.pathname}${search ? `?${search}` : ""}`;
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.pushState(null, "", url);
    setView(next);
  }, []);

  /** Back/forward changed the address bar. */
  const syncFromUrl = useCallback(() => setView(readViewFromUrl()), []);

  return { view, changeView, syncFromUrl };
}
