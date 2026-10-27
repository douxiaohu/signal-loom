import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import FilterPanel from "../src/components/FilterPanel";
import { filtersFromUrl, filtersToUrl, useSavedFilters } from "../src/public-api";

const filters = { chatId: "42", media: "photo" as const, query: "安全 漏洞" };

describe("saved reader filters", () => {
  it("round trips filters in a shareable URL and omits defaults", () => {
    expect(filtersToUrl(filters)).toBe("/?chat_id=42&media=photo&query=%E5%AE%89%E5%85%A8+%E6%BC%8F%E6%B4%9E");
    expect(filtersFromUrl(new URL(filtersToUrl(filters), "https://example.test").search)).toEqual(filters);
    expect(filtersToUrl({ chatId: "all", media: "all", query: "" })).toBe("/");
  });

  it("saves named combinations locally and restores them", async () => {
    const user = userEvent.setup();
    render(<SavedFiltersHarness />);
    await user.type(screen.getByLabelText("保存名称"), "安全阅读");
    await user.click(screen.getByRole("button", { name: "保存筛选" }));
    expect(screen.getByRole("option", { name: "安全阅读" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("已保存筛选"), "安全阅读");
    expect(screen.getByTestId("restored")).toHaveTextContent(JSON.stringify(filters));
  });
});

function SavedFiltersHarness() {
  const [current, setCurrent] = React.useState<import("../src/types").Filters>(filters);
  const saved = useSavedFilters();
  return <div>
    <input aria-label="保存名称" />
    <button onClick={() => saved.save("安全阅读", current)}>保存筛选</button>
    <select aria-label="已保存筛选" onChange={(event) => setCurrent(saved.get(event.target.value) || current)}>
      <option value="">选择</option>{saved.items.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
    </select>
    <output data-testid="restored">{JSON.stringify(current)}</output>
  </div>;
}

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
