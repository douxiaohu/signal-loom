import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";

import { useUrlFilters } from "../../src/hooks/useUrlFilters";
import { filtersToParams, parseFilters, withSearch } from "../../src/lib/filters";
import type { Filters } from "../../src/types";

const read = () => parseFilters(window.location.search);
const toUrl = (filters: Filters) => withSearch(window.location.pathname, filtersToParams(filters));

const SOURCE_42: Filters = { chatId: "42", media: "all", query: "" };

describe("useUrlFilters", () => {
  it("starts from what the address bar says", () => {
    window.history.replaceState(null, "", "/?chat_id=42&media=document&query=abc");
    const { result } = renderHook(() => useUrlFilters({ read, toUrl }));
    expect(result.current.filters).toEqual({ chatId: "42", media: "document", query: "abc" });
  });

  it("reads the address bar only once for the initial value", () => {
    const reader = vi.fn(read);
    const { rerender } = renderHook(() => useUrlFilters({ read: reader, toUrl }));
    rerender();
    rerender();
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("pushes a history entry for a new URL and reports that the list changed", () => {
    const push = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useUrlFilters({ read, toUrl }));

    let changed: boolean | undefined;
    act(() => {
      changed = result.current.commit(SOURCE_42);
    });

    expect(changed).toBe(true);
    expect(result.current.filters).toEqual(SOURCE_42);
    expect(window.location.search).toBe("?chat_id=42");
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("does not push a duplicate entry when the same filters are committed again", () => {
    const push = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useUrlFilters({ read, toUrl }));
    act(() => {
      result.current.commit(SOURCE_42);
    });

    let changed: boolean | undefined;
    act(() => {
      changed = result.current.commit({ ...SOURCE_42 });
    });

    expect(changed).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("can rewrite the current history entry instead of adding one", () => {
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const { result } = renderHook(() => useUrlFilters({ read, toUrl }));

    act(() => {
      result.current.commit(SOURCE_42, { replace: true });
    });

    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?chat_id=42");
    expect(result.current.filters).toEqual(SOURCE_42);
  });

  it("treats surrounding whitespace in the query as the same list, though the URL differs", () => {
    const { result } = renderHook(() => useUrlFilters({ read, toUrl }));
    act(() => {
      result.current.commit({ chatId: "all", media: "all", query: "漏洞" });
    });

    let changed: boolean | undefined;
    act(() => {
      changed = result.current.commit({ chatId: "all", media: "all", query: "漏洞 " });
    });
    expect(changed).toBe(false);
  });

  it("restores the filters on back/forward and tells the caller", () => {
    const onRestore = vi.fn();
    const { result } = renderHook(() => useUrlFilters({ read, toUrl, onRestore }));
    act(() => {
      result.current.commit(SOURCE_42);
    });

    act(() => {
      window.history.pushState(null, "", "/?query=back");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    const restored: Filters = { chatId: "all", media: "all", query: "back" };
    expect(result.current.filters).toEqual(restored);
    expect(onRestore).toHaveBeenCalledWith(restored);
  });

  it("knows about a restore when the next commit is compared", () => {
    const { result } = renderHook(() => useUrlFilters({ read, toUrl }));
    act(() => {
      result.current.commit(SOURCE_42);
    });
    act(() => {
      window.history.pushState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    let changed: boolean | undefined;
    act(() => {
      changed = result.current.commit({ chatId: "all", media: "all", query: "" });
    });
    expect(changed).toBe(false); // the list shown after "back" is already the default one
  });

  it("builds URLs with the newest toUrl", () => {
    const { result, rerender } = renderHook(
      ({ view }) => useUrlFilters({ read, toUrl: (filters) => withSearch("/", filtersToParams(filters, { view })) }),
      { initialProps: { view: "messages" } }
    );
    rerender({ view: "alerts" });

    act(() => {
      result.current.commit(SOURCE_42);
    });
    expect(window.location.search).toBe("?view=alerts&chat_id=42");
  });

  it("stops listening for back/forward once unmounted", () => {
    const onRestore = vi.fn();
    const { unmount } = renderHook(() => useUrlFilters({ read, toUrl, onRestore }));
    unmount();

    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(onRestore).not.toHaveBeenCalled();
  });
});
