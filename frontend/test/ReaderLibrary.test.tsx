import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSavedIds, useReaderLibrary } from "../src/hooks/useReaderLibrary";
import { readPosition } from "../src/hooks/useReadingPosition";
import { safeStorage } from "../src/lib/storage";

describe("reader preferences", () => {
  beforeEach(() => localStorage.clear());
  it("stores only unique positive message IDs and synchronizes open components", () => {
    localStorage.setItem("signal-saved-ids", '[1,"2",-1,null,1,2.5,2]');
    expect(readSavedIds()).toEqual([1, 2]);
    const first = renderHook(() => useReaderLibrary());
    const second = renderHook(() => useReaderLibrary());
    act(() => first.result.current.toggle(3));
    expect(second.result.current.ids).toEqual([3, 1, 2]);
    expect(localStorage.getItem("signal-saved-ids")).toBe("[3,1,2]");
    act(() => second.result.current.remove([1, 3]));
    expect(first.result.current.ids).toEqual([2]);
  });
  it("tolerates corrupt or unavailable storage and bounds the library", () => {
    localStorage.setItem("signal-saved-ids", "not-json");
    expect(readSavedIds()).toEqual([]);
    localStorage.setItem(
      "signal-saved-ids",
      JSON.stringify(Array.from({ length: 700 }, (_, i) => i + 1)),
    );
    expect(readSavedIds()).toHaveLength(500);
    vi.spyOn(safeStorage, "get").mockReturnValue(null);
    expect(readSavedIds()).toEqual([]);
  });
  it("restores only local reading URLs with a valid message anchor", () => {
    for (const url of [
      "https://evil.example",
      "//evil.example",
      "/admin",
      "/message/1",
    ]) {
      localStorage.setItem(
        "signal-reading-position",
        JSON.stringify({ id: 1, url, offset: 100 }),
      );
      expect(readPosition()).toBeNull();
    }
    localStorage.setItem(
      "signal-reading-position",
      JSON.stringify({ id: 1, url: "/?chat_id=-1&query=design", offset: 120 }),
    );
    expect(readPosition()?.id).toBe(1);
  });
});
