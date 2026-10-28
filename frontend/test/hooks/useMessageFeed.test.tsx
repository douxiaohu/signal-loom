import { act, renderHook, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { useMessageFeed, type FeedFetcher, type UseMessageFeedOptions } from "../../src/hooks/useMessageFeed";
import type { Filters } from "../../src/types";
import { abortable, deferred, message, page } from "./helpers";

const ALL: Filters = { chatId: "all", media: "all", query: "" };
const SOURCE_42: Filters = { chatId: "42", media: "all", query: "" };

function ids(result: { current: { messages: Array<{ id: number }> } }) {
  return result.current.messages.map((item) => item.id);
}

function setup(fetchPage: FeedFetcher, extra: Partial<UseMessageFeedOptions> = {}) {
  return renderHook(
    (props: { filters: Filters; enabled?: boolean }) =>
      useMessageFeed({ filters: props.filters, enabled: props.enabled, fetchPage, ...extra }),
    { initialProps: { filters: ALL, enabled: true } as { filters: Filters; enabled?: boolean } }
  );
}

describe("useMessageFeed", () => {
  it("loads the first page when it mounts", async () => {
    const fetchPage = vi.fn<FeedFetcher>(async () => page([2, 1]));
    const { result } = setup(fetchPage);

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(ids(result)).toEqual([2, 1]);
    expect(result.current.error).toBe("");
    expect(result.current.lastLoadedAt).toBeInstanceOf(Date);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0][0]).toMatchObject({ filters: ALL });
    expect(fetchPage.mock.calls[0][0].cursor).toBeUndefined();
  });

  it("appends the next page without duplicates and follows the cursor", async () => {
    const fetchPage = vi.fn<FeedFetcher>(async ({ cursor }) => (cursor ? page([1, 2], false, null) : page([1], true, "c1")));
    const { result } = setup(fetchPage);
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => { await result.current.loadMore(); });

    expect(ids(result)).toEqual([1, 2]);
    expect(result.current.hasMore).toBe(false);
    expect(fetchPage.mock.calls[1][0].cursor).toBe("c1");
    await act(async () => { await result.current.loadMore(); });
    expect(fetchPage).toHaveBeenCalledTimes(2); // nothing left to load
  });

  it("starts only one 'load more' at a time", async () => {
    const more = deferred<ReturnType<typeof page>>();
    const fetchPage = vi.fn<FeedFetcher>(async ({ cursor }) => (cursor ? more.promise : page([1], true, "c1")));
    const { result } = setup(fetchPage);
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    let first!: Promise<void>;
    act(() => {
      first = result.current.loadMore();
      void result.current.loadMore();
      void result.current.loadMore();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.current.loadingMore).toBe(true);

    more.resolve(page([2]));
    await act(async () => { await first; });
    expect(ids(result)).toEqual([1, 2]);
    expect(result.current.loadingMore).toBe(false);
  });

  it("drops a 'load more' answer that arrives after the filters changed", async () => {
    // Regression: on the public site the late page of the old source used to be
    // appended to the list of the new one.
    const slowMore = deferred<ReturnType<typeof page>>();
    let moreSignal!: AbortSignal;
    const fetchPage = vi.fn<FeedFetcher>(async ({ filters, cursor, signal }) => {
      if (cursor) {
        moreSignal = signal;
        return slowMore.promise;
      }
      return filters.chatId === "all" ? page([1], true, "c1") : page([100]);
    });
    const { result, rerender } = setup(fetchPage);
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    let pendingMore!: Promise<void>;
    act(() => { pendingMore = result.current.loadMore(); });
    expect(result.current.loadingMore).toBe(true);

    rerender({ filters: SOURCE_42 });
    await waitFor(() => expect(ids(result)).toEqual([100]));
    expect(moreSignal.aborted).toBe(true);

    slowMore.resolve(page([2, 3])); // the answer for the old source shows up late
    await act(async () => { await pendingMore; });

    expect(ids(result)).toEqual([100]);
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.hasMore).toBe(false);
  });

  it("surfaces a failed 'load more' and lets the user try again", async () => {
    // Regression: the failure used to be an unhandled promise rejection.
    let failNext = true;
    const fetchPage = vi.fn<FeedFetcher>(async ({ cursor }) => {
      if (!cursor) return page([1], true, "c1");
      if (failNext) {
        failNext = false;
        throw new Error("加载失败");
      }
      return page([2]);
    });
    const { result } = setup(fetchPage);
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => { await result.current.loadMore(); });
    expect(result.current.error).toBe("加载失败");
    expect(result.current.loadingMore).toBe(false);
    expect(ids(result)).toEqual([1]);
    expect(result.current.hasMore).toBe(true);

    await act(async () => { await result.current.loadMore(); });
    expect(result.current.error).toBe("");
    expect(ids(result)).toEqual([1, 2]);
  });

  it("keeps the newest filters' result when an older request finishes last", async () => {
    const older = deferred<ReturnType<typeof page>>();
    const fetchPage = vi.fn<FeedFetcher>(({ filters, signal }) =>
      filters.chatId === "all" ? abortable(signal, older.promise) : Promise.resolve(page([100]))
    );
    const { result, rerender } = setup(fetchPage);
    rerender({ filters: SOURCE_42 });
    await waitFor(() => expect(ids(result)).toEqual([100]));

    older.resolve(page([1]));
    await act(async () => { await Promise.resolve(); });
    expect(ids(result)).toEqual([100]);
    expect(result.current.loading).toBe(false);
  });

  it("ignores an answer that was not cancelled but belongs to an earlier load", async () => {
    // A fetcher that does not honour AbortSignal must not be able to corrupt the list.
    const older = deferred<ReturnType<typeof page>>();
    const fetchPage = vi.fn<FeedFetcher>(({ filters }) => (filters.chatId === "all" ? older.promise : Promise.resolve(page([100]))));
    const { result, rerender } = setup(fetchPage);
    rerender({ filters: SOURCE_42 });
    await waitFor(() => expect(ids(result)).toEqual([100]));

    older.resolve(page([1, 2, 3]));
    await act(async () => { await Promise.resolve(); });
    expect(ids(result)).toEqual([100]);
  });

  it("shows a cached first page at once and revalidates it in the background", async () => {
    const second = deferred<ReturnType<typeof page>>();
    let allCalls = 0;
    const fetchPage = vi.fn<FeedFetcher>(async ({ filters }) => {
      if (filters.chatId !== "all") return page([100]);
      allCalls += 1;
      return allCalls === 1 ? page([1]) : second.promise;
    });
    const { result, rerender } = setup(fetchPage, { cache: { ttlMs: 60_000, limit: 5 } });
    await waitFor(() => expect(ids(result)).toEqual([1]));

    rerender({ filters: SOURCE_42 });
    await waitFor(() => expect(ids(result)).toEqual([100]));
    rerender({ filters: ALL });

    expect(ids(result)).toEqual([1]); // from the cache, before any network answer
    expect(result.current.loading).toBe(true); // ...while it is re-fetched
    second.resolve(page([5, 1]));
    await waitFor(() => expect(ids(result)).toEqual([5, 1]));
    expect(result.current.loading).toBe(false);
  });

  it("does not use a cached page past its time to live", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-13T08:00:00Z"));
    const fetchPage = vi.fn<FeedFetcher>(async ({ filters }) => (filters.chatId === "all" ? page([1]) : page([100])));
    const { result, rerender } = setup(fetchPage, { cache: { ttlMs: 60_000, limit: 5 } });
    await waitFor(() => expect(ids(result)).toEqual([1]));
    rerender({ filters: SOURCE_42 });
    await waitFor(() => expect(ids(result)).toEqual([100]));

    vi.setSystemTime(new Date("2026-07-13T08:02:00Z"));
    const slow = deferred<ReturnType<typeof page>>();
    fetchPage.mockImplementationOnce(() => slow.promise);
    rerender({ filters: ALL });

    expect(ids(result)).toEqual([]); // expired entry: start from an empty list
    slow.resolve(page([1]));
    await waitFor(() => expect(ids(result)).toEqual([1]));
  });

  it("forgets the oldest cached filter sets beyond its limit", async () => {
    const fetchPage = vi.fn<FeedFetcher>(async ({ filters }) => page([Number(filters.chatId) || 1]));
    const { result, rerender } = setup(fetchPage, { cache: { ttlMs: 60_000, limit: 2 } });
    await waitFor(() => expect(ids(result)).toEqual([1]));
    for (const chat of ["2", "3"]) {
      rerender({ filters: { ...ALL, chatId: chat } });
      await waitFor(() => expect(ids(result)).toEqual([Number(chat)]));
    }

    const slow = deferred<ReturnType<typeof page>>();
    fetchPage.mockImplementationOnce(() => slow.promise);
    rerender({ filters: ALL }); // "all" was the oldest of three with a limit of two
    expect(ids(result)).toEqual([]);
    slow.resolve(page([1]));
    await waitFor(() => expect(ids(result)).toEqual([1]));
  });

  it("clears the list at once by default and keeps it when asked to", async () => {
    for (const keepPrevious of [false, true]) {
      const slow = deferred<ReturnType<typeof page>>();
      const fetchPage = vi.fn<FeedFetcher>(({ filters }) => (filters.chatId === "all" ? Promise.resolve(page([1])) : slow.promise));
      const { result, rerender, unmount } = setup(fetchPage, { keepPrevious });
      await waitFor(() => expect(ids(result)).toEqual([1]));

      rerender({ filters: SOURCE_42 });
      expect(ids(result)).toEqual(keepPrevious ? [1] : []);
      expect(result.current.loading).toBe(true);

      slow.resolve(page([100]));
      await waitFor(() => expect(ids(result)).toEqual([100]));
      unmount();
    }
  });

  it("does nothing while disabled, loads when enabled and empties itself when disabled again", async () => {
    const fetchPage = vi.fn<FeedFetcher>(async () => page([1]));
    const { result, rerender } = setup(fetchPage);
    rerender({ filters: ALL, enabled: false });
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetchPage.mockClear();
    expect(ids(result)).toEqual([]);

    rerender({ filters: ALL, enabled: true });
    await waitFor(() => expect(ids(result)).toEqual([1]));
    expect(fetchPage).toHaveBeenCalledTimes(1);

    rerender({ filters: ALL, enabled: false });
    await waitFor(() => expect(ids(result)).toEqual([]));
    expect(result.current.hasMore).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it("is idle from the start when it begins disabled", () => {
    const fetchPage = vi.fn<FeedFetcher>(async () => page([1]));
    const { result } = renderHook(() => useMessageFeed({ filters: ALL, fetchPage, enabled: false }));
    expect(result.current.loading).toBe(false);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("reports failures to onError but never reports cancellations", async () => {
    const onError = vi.fn();
    const fetchPage = vi.fn<FeedFetcher>(({ filters, signal }) =>
      filters.chatId === "all" ? abortable(signal, new Promise<never>(() => undefined)) : Promise.reject(new Error("503"))
    );
    const { result, rerender } = setup(fetchPage, { onError, formatError: (caught) => `出错：${(caught as Error).message}` });

    rerender({ filters: SOURCE_42 }); // cancels the first request, which rejects with AbortError
    await waitFor(() => expect(result.current.error).toBe("出错：503"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ message: "503" });
    expect(result.current.loading).toBe(false);
  });

  it("reload() forgets the cache and fetches again, flagging the refresh until it lands", async () => {
    const second = deferred<ReturnType<typeof page>>();
    let calls = 0;
    const fetchPage = vi.fn<FeedFetcher>(async () => (++calls === 1 ? page([1]) : second.promise));
    const { result } = setup(fetchPage, { cache: { ttlMs: 60_000, limit: 5 } });
    await waitFor(() => expect(ids(result)).toEqual([1]));

    act(() => result.current.reload());
    expect(result.current.refreshing).toBe(true);
    await waitFor(() => expect(ids(result)).toEqual([])); // cache dropped: skeleton, not stale data
    second.resolve(page([7]));
    await waitFor(() => expect(ids(result)).toEqual([7]));
    expect(result.current.refreshing).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("revalidate() refetches but keeps the cached list on screen", async () => {
    const second = deferred<ReturnType<typeof page>>();
    let calls = 0;
    const fetchPage = vi.fn<FeedFetcher>(async () => (++calls === 1 ? page([1]) : second.promise));
    const { result } = setup(fetchPage, { cache: { ttlMs: 60_000, limit: 5 } });
    await waitFor(() => expect(ids(result)).toEqual([1]));

    act(() => result.current.revalidate());
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(ids(result)).toEqual([1]);
    second.resolve(page([2, 1]));
    await waitFor(() => expect(ids(result)).toEqual([2, 1]));
  });

  it("prepends messages without duplicating the ones already shown", async () => {
    const { result } = setup(async () => page([2, 1]));
    await waitFor(() => expect(ids(result)).toEqual([2, 1]));

    act(() => result.current.prepend([message(3), message(2)]));
    expect(ids(result)).toEqual([3, 2, 1]);
  });

  it("changes `generation` whenever a fresh first page starts loading", async () => {
    const { result, rerender } = setup(async () => page([1]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const first = result.current.generation;
    rerender({ filters: SOURCE_42 });
    await waitFor(() => expect(result.current.generation).not.toBe(first));
  });

  it("cancels what is in flight when it unmounts", async () => {
    let signal!: AbortSignal;
    const fetchPage = vi.fn<FeedFetcher>((args) => {
      signal = args.signal;
      return new Promise<never>(() => undefined);
    });
    const { unmount } = setup(fetchPage);
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("de-duplicates ids that the server repeats inside one page", async () => {
    const { result } = setup(async () => ({ items: [message(1), message(1, "newer"), message(2)], has_more: false, next_cursor: null, total: null }));
    await waitFor(() => expect(ids(result)).toEqual([1, 2]));
    expect(result.current.messages[0].content).toBe("newer");
  });
});
