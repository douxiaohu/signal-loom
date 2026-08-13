import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThemeSwitcher } from "../src/theme";

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("applies and persists the selected palette", async () => {
    render(<ThemeSwitcher />);
    await userEvent.setup().selectOptions(screen.getByLabelText("界面主题"), "paper");

    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(window.localStorage.getItem("tm-theme")).toBe("paper");
  });
});
