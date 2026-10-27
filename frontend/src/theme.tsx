import type { ChangeEvent } from "react";

export type ThemeId = "midnight" | "aurora" | "ember" | "paper";

const options: Array<[ThemeId, string]> = [["paper", "白色"], ["midnight", "午夜蓝"], ["aurora", "极光绿"], ["ember", "余烬橙"]];
const themeColor: Record<ThemeId, string> = {
  paper: "#f7f6f4",
  midnight: "#13141a",
  aurora: "#101915",
  ember: "#1b1612"
};
const storageKey = "tm-theme";

function readTheme(): ThemeId {
  const stored = window.localStorage.getItem(storageKey);
  if (stored === "midnight" || stored === "aurora" || stored === "ember" || stored === "paper") return stored;
  return "midnight";
}

function applyTheme(theme: ThemeId) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor[theme]);
}

function selectTheme(event: ChangeEvent<HTMLSelectElement>) {
  const value = event.target.value;
  const theme = value === "midnight" || value === "aurora" || value === "ember" || value === "paper" ? value : "midnight";
  applyTheme(theme);
  window.localStorage.setItem(storageKey, theme);
}

applyTheme(readTheme());

export function ThemeSwitcher() {
  const theme = readTheme();
  document.documentElement.dataset.theme = theme;
  return (
    <label className="theme-picker">
      <span className="theme-swatch" aria-hidden="true" />
      <span className="theme-picker-label">主题</span>
      <select aria-label="界面主题" defaultValue={theme} onChange={selectTheme}>
        {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
  );
}
