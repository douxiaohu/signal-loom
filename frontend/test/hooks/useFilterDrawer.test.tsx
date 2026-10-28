import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";

import { useFilterDrawer } from "../../src/hooks/useFilterDrawer";

describe("useFilterDrawer", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens and closes", () => {
    const { result } = renderHook(() => useFilterDrawer());
    expect(result.current.open).toBe(false);

    act(() => result.current.show());
    expect(result.current.open).toBe(true);
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
  });

  it("hands focus back to what had it when the drawer opened", () => {
    document.body.innerHTML = '<button id="opener">筛选</button><button id="other">其他</button>';
    const opener = document.getElementById("opener") as HTMLButtonElement;
    const other = document.getElementById("other") as HTMLButtonElement;
    const { result } = renderHook(() => useFilterDrawer());

    opener.focus();
    act(() => result.current.show());
    other.focus();
    act(() => result.current.close());

    expect(document.activeElement).toBe(opener);
  });

  it("closes on Escape only while open", () => {
    const { result } = renderHook(() => useFilterDrawer());

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(result.current.open).toBe(false);

    act(() => result.current.show());
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
    expect(result.current.open).toBe(true);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(result.current.open).toBe(false);
  });

  it("stops listening for keys once closed or unmounted", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { result, unmount } = renderHook(() => useFilterDrawer());
    act(() => result.current.show());
    act(() => result.current.close());
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));

    act(() => result.current.show());
    remove.mockClear();
    unmount();
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
  });
});
