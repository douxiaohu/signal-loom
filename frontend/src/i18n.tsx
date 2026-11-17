import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { safeStorage } from "./lib/storage";
let dictionary: Record<string, string[]> = {};
let loaded = false;
async function loadDictionary() {
  if (!loaded) {
    dictionary = (await import("./translations")).dictionary;
    loaded = true;
  }
}
export type Locale = "zh-CN" | "en" | "ja" | "es";
export const languages: [Locale, string][] = [
  ["zh-CN", "简体中文"],
  ["en", "English"],
  ["ja", "日本語"],
  ["es", "Español"],
];
let activeLocale: Locale = "zh-CN";
export function getLocale() {
  return activeLocale;
}
function storedLocale(): Locale {
  const value = safeStorage.get("signal-language");
  return languages.some(([id]) => id === value) ? (value as Locale) : "zh-CN";
}
export function initializeLanguage() {
  activeLocale = storedLocale();
  document.documentElement.lang = activeLocale;
}
export function translate(
  text: string,
  values: Record<string, string | number> = {},
  locale = activeLocale,
): string {
  const index = ["en", "ja", "es"].indexOf(locale);
  const value = index < 0 ? text : dictionary[text]?.[index] || text;
  return value.replace(/\{(\w+)\}/g, (match, key) =>
    String(values[key] ?? match),
  );
}
const LanguageContext = createContext({
  locale: "zh-CN" as Locale,
  setLocale: (_: Locale) => {},
});
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setState] = useState(storedLocale);
  const [ready, setReady] = useState(() => storedLocale() === "zh-CN");
  activeLocale = locale;
  useEffect(() => {
    let disposed = false;
    if (locale !== "zh-CN")
      void loadDictionary()
        .then(() => {
          if (!disposed) setReady(true);
        })
        .catch(() => {
          if (!disposed) {
            setState("zh-CN");
            setReady(true);
          }
        });
    return () => {
      disposed = true;
    };
  }, []);
  const setLocale = (value: Locale) => {
    void (value === "zh-CN" ? Promise.resolve() : loadDictionary()).then(() => {
      activeLocale = value;
      safeStorage.set("signal-language", value);
      document.documentElement.lang = value;
      setState(value);
      setReady(true);
    });
  };
  return (
    <LanguageContext.Provider value={{ locale, setLocale }}>
      {ready ? children : <div className="boot-screen">Signal Loom…</div>}
    </LanguageContext.Provider>
  );
}
export function useI18n() {
  const { locale } = useContext(LanguageContext);
  return {
    locale,
    t: (text: string, values?: Record<string, string | number>) =>
      translate(text, values, locale),
  };
}
export function LanguageSelect() {
  const { locale, setLocale } = useContext(LanguageContext);
  return (
    <select
      className="reader-language"
      aria-label="Language / 语言"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
    >
      {languages.map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </select>
  );
}
