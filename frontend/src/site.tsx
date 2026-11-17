import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { request } from "./lib/http";
export type SiteSettings = {
  name: string;
  description: string;
  base_url: string;
};
const defaults: SiteSettings = {
  name: "拾讯",
  description: "拾起消息，织成日常。",
  base_url: "",
};
const SiteContext = createContext(defaults);
export function messageUrl(site: SiteSettings, id: number) {
  return new URL(`/message/${id}`, site.base_url || window.location.origin)
    .href;
}
export function SiteProvider({ children }: { children: ReactNode }) {
  const [site, setSite] = useState(defaults);
  useEffect(() => {
    const controller = new AbortController();
    void request<SiteSettings>("/api/public/config", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setSite({ ...defaults, ...value });
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    document.title = window.location.pathname.startsWith("/admin")
      ? `${site.name} · 管理中心 | Signal Loom`
      : `${site.name} · Signal Loom`;
    document
      .querySelector('meta[name="application-name"]')
      ?.setAttribute("content", site.name);
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", site.description);
  }, [site]);
  return <SiteContext.Provider value={site}>{children}</SiteContext.Provider>;
}
export function useSite() {
  return useContext(SiteContext);
}
