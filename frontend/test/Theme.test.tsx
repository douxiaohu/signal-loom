import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThemeSelect, ThemeSwitcher } from "../src/theme";

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

  it("keeps the select-based picker working for the console shell", async () => {
    render(<ThemeSelect />);
    await userEvent.setup().selectOptions(screen.getByLabelText("界面主题"), "paper");
    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(window.localStorage.getItem("tm-theme")).toBe("paper");
  });
});
