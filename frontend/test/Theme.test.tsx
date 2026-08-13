import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThemeSwitcher } from "../src/theme";

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("defaults to the white palette and can switch away", async () => {
    render(<ThemeSwitcher />);
    expect(document.documentElement.dataset.theme).toBe("paper");

    await userEvent.setup().selectOptions(screen.getByLabelText("界面主题"), "midnight");

    expect(document.documentElement.dataset.theme).toBe("midnight");
    expect(window.localStorage.getItem("tm-theme")).toBe("midnight");
  });
});
