import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { initializePublicTheme, ReadingLightSwitch, ThemeSelect, ThemeSwitcher } from "../src/theme";

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("defaults to the midnight dark palette and can switch away", async () => {
    render(<ThemeSwitcher />);
    expect(document.documentElement.dataset.theme).toBe("midnight");

    await userEvent.setup().click(screen.getByRole("radio", { name: "白色主题" }));

    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(window.localStorage.getItem("tm-theme")).toBe("paper");
    expect(screen.getByRole("radio", { name: "白色主题" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "午夜蓝主题" })).toHaveAttribute("aria-checked", "false");
  });

  it("still switches themes when the browser refuses to store the preference", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    render(<ThemeSwitcher />);
    await userEvent.setup().click(screen.getByRole("radio", { name: "极光绿主题" }));
    expect(document.documentElement.dataset.theme).toBe("aurora");
    expect(screen.getByRole("radio", { name: "极光绿主题" })).toHaveAttribute("aria-checked", "true");
  });

  it("falls back to the default when stored data cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => render(<ThemeSwitcher />)).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("midnight");
  });

  it("keeps the select-based picker working for the console shell", async () => {
    render(<ThemeSelect />);
    await userEvent.setup().selectOptions(screen.getByLabelText("界面主题"), "paper");
    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(window.localStorage.getItem("tm-theme")).toBe("paper");
  });

  it("starts a new public reader on paper and keeps both reading switches in sync", async () => {
    initializePublicTheme();
    render(<><ReadingLightSwitch /><ReadingLightSwitch /></>);
    expect(document.documentElement.dataset.theme).toBe("paper");
    await userEvent.setup().click(screen.getAllByRole("button", { name: "切换到夜间" })[0]);
    expect(screen.getAllByRole("button", { name: "切换到日间" })).toHaveLength(2);
    expect(window.localStorage.getItem("tm-theme")).toBe("midnight");
  });

  it("preserves a returning public reader's saved choice", () => {
    window.localStorage.setItem("tm-theme", "aurora");
    render(<ThemeSwitcher />);
    initializePublicTheme();
    expect(document.documentElement.dataset.theme).toBe("aurora");
    expect(window.localStorage.getItem("tm-theme")).toBe("aurora");
  });
});
