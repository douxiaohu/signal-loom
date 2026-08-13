import type { ChangeEvent } from "react";

export type ThemeId = "midnight" | "aurora" | "ember" | "paper";

const options: Array<[ThemeId, string]> = [["midnight", "午夜蓝"], ["aurora", "极光绿"], ["ember", "余烬橙"], ["paper", "白色"]];
const storageKey = "tm-theme";

function readTheme(): ThemeId {
  return (window.localStorage.getItem(storageKey) || "midnight") as ThemeId;
}

function selectTheme(event: ChangeEvent<HTMLSelectElement>) {
  const value = event.target.value;
  document.documentElement.dataset.theme = value;
  window.localStorage.setItem(storageKey, value);
}

document.documentElement.dataset.theme = readTheme();

export function ThemeSwitcher() {
  const theme = readTheme();
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
