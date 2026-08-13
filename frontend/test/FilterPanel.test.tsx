import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import FilterPanel from "../src/components/FilterPanel";

describe("FilterPanel", () => {
  it("exposes an open responsive drawer as a modal dialog and traps keyboard focus", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(max-width: 1180px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    })));
    render(
      <FilterPanel
        draft={{ chatId: "all", media: "all", query: "" }}
        groups={[]}
        open
        onChange={() => undefined}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />
    );
    const user = userEvent.setup();
    const dialog = screen.getByRole("dialog", { name: "来源与筛选" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(screen.getByRole("radio", { name: /全部来源/ })).toHaveFocus());

    const closeButton = screen.getByRole("button", { name: "关闭筛选" });
    const submitButton = screen.getByRole("button", { name: "应用筛选" });
    submitButton.focus();
    await user.tab();
    expect(closeButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(submitButton).toHaveFocus();
  });
});
