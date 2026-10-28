import { renderHook } from "@testing-library/react";
import { vi } from "vitest";

import { usePolling } from "../../src/hooks/usePolling";

describe("usePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("calls the callback once per interval", () => {
    const callback = vi.fn();
    renderHook(() => usePolling(callback, 1_000));

    vi.advanceTimersByTime(999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_501);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("runs the newest callback without restarting the timer", () => {
    const first = vi.fn();
    const second = vi.fn();
    const setInterval = vi.spyOn(window, "setInterval");
    const { rerender } = renderHook(({ callback }) => usePolling(callback, 1_000), { initialProps: { callback: first } });

    vi.advanceTimersByTime(1_000);
    rerender({ callback: second });
    vi.advanceTimersByTime(1_000);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(setInterval).toHaveBeenCalledTimes(1);
  });

  it("skips ticks while the tab is hidden and resumes when it is visible again", () => {
    const callback = vi.fn();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    renderHook(() => usePolling(callback, 1_000));

    vi.advanceTimersByTime(3_000);
    expect(callback).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    vi.advanceTimersByTime(1_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not start a timer while disabled", () => {
    const callback = vi.fn();
    const { rerender } = renderHook(({ enabled }) => usePolling(callback, 1_000, enabled), { initialProps: { enabled: false } });
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(5_000);
    expect(callback).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(callback).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts with the new period when the interval changes", () => {
    const callback = vi.fn();
    const { rerender } = renderHook(({ ms }) => usePolling(callback, ms), { initialProps: { ms: 1_000 } });
    rerender({ ms: 5_000 });
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(4_999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("clears its timer when unmounted", () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => usePolling(callback, 1_000));
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(callback).not.toHaveBeenCalled();
  });
});
