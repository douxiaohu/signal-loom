import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";

import { readViewFromUrl, useAdminView } from "../../src/hooks/useAdminView";

describe("useAdminView", () => {
  it.each([
    ["/", "overview"],
    ["/?view=sources", "sources"],
    ["/?view=visits", "visits"],
    ["/?view=alerts", "alerts"],
    ["/?view=messages&query=abc", "messages"],
    ["/?view=unknown", "overview"]
  ])("reads %s as %s", (url, expected) => {
    window.history.replaceState(null, "", url);
    expect(readViewFromUrl()).toBe(expected);
    expect(renderHook(() => useAdminView()).result.current.view).toBe(expected);
  });

  it("opens a page, adding a history entry and keeping the message filters", () => {
    window.history.replaceState(null, "", "/?query=abc&media=document");
    const push = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useAdminView());

    act(() => result.current.changeView("messages"));

    expect(result.current.view).toBe("messages");
    expect(window.location.search).toBe("?query=abc&media=document&view=messages");
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("leaves the address clean for the overview", () => {
    window.history.replaceState(null, "", "/?view=sources");
    const { result } = renderHook(() => useAdminView());

    act(() => result.current.changeView("overview"));

    expect(result.current.view).toBe("overview");
    expect(window.location.search).toBe("");
  });

  it("does not add a history entry for the page that is already open", () => {
    window.history.replaceState(null, "", "/?view=alerts");
    const push = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useAdminView());

    act(() => result.current.changeView("alerts"));

    expect(push).not.toHaveBeenCalled();
    expect(result.current.view).toBe("alerts");
  });

  it("follows the address bar after back/forward", () => {
    const { result } = renderHook(() => useAdminView());
    expect(result.current.view).toBe("overview");

    act(() => {
      window.history.pushState(null, "", "/?view=visits");
      result.current.syncFromUrl();
    });

    expect(result.current.view).toBe("visits");
  });
});
