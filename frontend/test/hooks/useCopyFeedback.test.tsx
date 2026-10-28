import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";

import { useCopyFeedback } from "../../src/hooks/useCopyFeedback";
import { deferred } from "./helpers";

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("useCopyFeedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("reports a successful copy for two seconds", async () => {
    const writeText = stubClipboard(vi.fn(async () => undefined));
    const { result } = renderHook(() => useCopyFeedback());
    expect(result.current.state).toBe("idle");

    await act(async () => { await result.current.copy("正文"); });
    expect(writeText).toHaveBeenCalledWith("正文");
    expect(result.current.state).toBe("copied");

    act(() => { vi.advanceTimersByTime(1_999); });
    expect(result.current.state).toBe("copied");
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.state).toBe("idle");
  });

  it("reports a refused copy instead of failing silently or throwing", async () => {
    stubClipboard(vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }));
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => { await result.current.copy("正文"); });

    expect(result.current.state).toBe("failed");
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(result.current.state).toBe("idle");
  });

  it("works on pages where the async clipboard does not exist (plain http)", async () => {
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => { await result.current.copy("正文"); });

    expect(result.current.state).toBe("failed"); // jsdom has no execCommand either
  });

  it("restarts the countdown when copying again", async () => {
    stubClipboard(vi.fn(async () => undefined));
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => { await result.current.copy("一"); });
    act(() => { vi.advanceTimersByTime(1_500); });
    await act(async () => { await result.current.copy("二"); });
    act(() => { vi.advanceTimersByTime(1_500); }); // 3 s after the first copy, 1.5 s after the second
    expect(result.current.state).toBe("copied");

    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current.state).toBe("idle");
  });

  it("leaves no timer behind when it unmounts", async () => {
    stubClipboard(vi.fn(async () => undefined));
    const { result, unmount } = renderHook(() => useCopyFeedback());
    await act(async () => { await result.current.copy("正文"); });
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a copy that finishes after it unmounted", async () => {
    const pending = deferred<void>();
    stubClipboard(vi.fn(() => pending.promise));
    const { result, unmount } = renderHook(() => useCopyFeedback());

    let copying!: Promise<void>;
    act(() => { copying = result.current.copy("正文"); });
    unmount();
    pending.resolve();
    await act(async () => { await copying; });

    expect(vi.getTimerCount()).toBe(0);
  });
});
