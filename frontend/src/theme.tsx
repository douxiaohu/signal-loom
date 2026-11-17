import { useEffect, useState, type ChangeEvent } from "react";
import { Moon, Sun } from "lucide-react";

import { useI18n } from "./i18n";
import { safeStorage } from "./lib/storage";

export type ThemeId = "midnight" | "aurora" | "ember" | "paper";

const options: Array<[ThemeId, string]> = [
  ["paper", "白色"],
  ["midnight", "午夜蓝"],
  ["aurora", "极光绿"],
  ["ember", "余烬橙"],
];
const themeColor: Record<ThemeId, string> = {
  paper: "#f5f6f8",
  midnight: "#0b0f17",
  aurora: "#08120f",
  ember: "#120d09",
};
const storageKey = "tm-theme";
const themeEvent = "tm-theme-change";

function isThemeId(value: unknown): value is ThemeId {
  return (
    value === "midnight" ||
    value === "aurora" ||
    value === "ember" ||
    value === "paper"
  );
}

function readTheme(): ThemeId {
  const stored = safeStorage.get(storageKey);
  return isThemeId(stored) ? stored : "midnight";
}

function applyTheme(theme: ThemeId) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", themeColor[theme]);
}

function setTheme(theme: ThemeId) {
  applyTheme(theme);
  safeStorage.set(storageKey, theme);
  window.dispatchEvent(new CustomEvent<ThemeId>(themeEvent, { detail: theme }));
}

/** New public readers start on warm paper; saved choices and the console default survive. */
export function initializePublicTheme() {
  if (!isThemeId(safeStorage.get(storageKey))) applyTheme("paper");
}

export function useStoredTheme(): ThemeId {
  const currentTheme = () =>
    isThemeId(document.documentElement.dataset.theme)
      ? document.documentElement.dataset.theme
      : readTheme();
  const [theme, setState] = useState<ThemeId>(currentTheme);
  useEffect(() => {
    applyTheme(currentTheme());
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<ThemeId>).detail;
      setState(isThemeId(detail) ? detail : readTheme());
    };
    window.addEventListener(themeEvent, sync);
    return () => window.removeEventListener(themeEvent, sync);
  }, []);
  return theme;
}

export function ReadingLightSwitch() {
  const { t } = useI18n();
  const theme = useStoredTheme();
  const night = theme !== "paper";
  return (
    <button
      className="reading-light"
      type="button"
      aria-label={t(night ? "切换到日间" : "切换到夜间")}
      aria-pressed={night}
      onClick={() => setTheme(night ? "paper" : "midnight")}
    >
      {night ? (
        <Moon size={15} aria-hidden="true" />
      ) : (
        <Sun size={15} aria-hidden="true" />
      )}
      <span>{t(night ? "夜间" : "日间")}</span>
    </button>
  );
}

applyTheme(readTheme());

/** Compact segmented theme picker used by the public site. */
export function ThemeSwitcher() {
  const theme = useStoredTheme();
  return (
    <div className="theme-switch" role="radiogroup" aria-label="界面主题">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={`${label}主题`}
          title={`${label}主题`}
          onClick={() => setTheme(value)}
        >
          <span
            className="theme-switch-dot"
            data-theme-id={value}
            aria-hidden="true"
          />
        </button>
      ))}
    </div>
  );
}

/** Select-based picker kept for the console (admin) shell. */
export function ThemeSelect() {
  const theme = useStoredTheme();
  function onChange(event: ChangeEvent<HTMLSelectElement>) {
    setTheme(isThemeId(event.target.value) ? event.target.value : "midnight");
  }
  return (
    <label className="theme-picker">
      <span className="theme-swatch" aria-hidden="true" />
      <span className="theme-picker-label">主题</span>
      <select aria-label="界面主题" value={theme} onChange={onChange}>
        {options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
