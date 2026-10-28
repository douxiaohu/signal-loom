import { act, renderHook, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { useVisits } from "../../src/hooks/useVisits";
import { EMPTY_STATS, callsTo, deferred, json, stubFetch } from "./helpers";

const visit = (id: number) => ({ id, visited_at: "2026-07-14T08:00:00+00:00", ip: "203.0.113.7", path: "/", method: "GET", user_agent: "test", referer: "" });

function setup(initial = { authenticated: true, active: true }, onUnauthorized: (caught: unknown) => void = vi.fn()) {
  return renderHook((props: { authenticated: boolean; active: boolean }) => useVisits({ ...props, onUnauthorized }), { initialProps: initial });
}

describe("useVisits", () => {
  it("does not fetch until its view is open", async () => {
    const fetchMock = stubFetch((url) => (url.pathname === "/api/admin/visits" ? json({ items: [visit(1)], stats: EMPTY_STATS }) : undefined));
    const { result, rerender } = setup({ authenticated: true, active: false });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);

    rerender({ authenticated: true, active: true });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.stats).toEqual(EMPTY_STATS);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("");
  });

  it("does not fetch while signed out", async () => {
    const fetchMock = stubFetch(() => undefined);
    setup({ authenticated: false, active: true });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches again every time the view is reopened, keeping the old rows meanwhile", async () => {
    const second = deferred<Response>();
    let calls = 0;
    const fetchMock = stubFetch((url) => {
      if (url.pathname !== "/api/admin/visits") return undefined;
      calls += 1;
      return calls === 1 ? json({ items: [visit(1)], stats: EMPTY_STATS }) : second.promise;
    });
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    rerender({ authenticated: true, active: false });
    rerender({ authenticated: true, active: true });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.loading).toBe(true);
    second.resolve(await json({ items: [visit(3), visit(2)], stats: EMPTY_STATS }));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(callsTo(fetchMock, "/api/admin/visits")).toBe(2);
  });

  it("cancels the request when the view is closed before it answers", async () => {
    let signal: AbortSignal | undefined;
    stubFetch((url, init) => {
      if (url.pathname !== "/api/admin/visits") return undefined;
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const { result, rerender } = setup();
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);

    rerender({ authenticated: true, active: false });

    expect(signal?.aborted).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it("shows why loading failed and retries on request", async () => {
    let calls = 0;
    stubFetch((url) => {
      if (url.pathname !== "/api/admin/visits") return undefined;
      calls += 1;
      return calls === 1 ? json({ detail: "数据库繁忙" }, 503) : json({ items: [visit(1)], stats: EMPTY_STATS });
    });
    const { result } = setup();

    await waitFor(() => expect(result.current.error).toContain("数据库繁忙"));
    expect(result.current.loading).toBe(false);

    act(() => result.current.reload());
    expect(result.current.error).toBe("");
    await waitFor(() => expect(result.current.items).toHaveLength(1));
  });

  it("hands a 401 to onUnauthorized", async () => {
    stubFetch((url) => (url.pathname === "/api/admin/visits" ? json({ detail: "expired" }, 401) : undefined));
    const onUnauthorized = vi.fn();
    setup({ authenticated: true, active: true }, onUnauthorized);

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(onUnauthorized.mock.calls[0][0]).toMatchObject({ status: 401 });
  });

  it("drops the rows on sign-out", async () => {
    stubFetch((url) => (url.pathname === "/api/admin/visits" ? json({ items: [visit(1)], stats: EMPTY_STATS }) : undefined));
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    rerender({ authenticated: false, active: true });

    expect(result.current.items).toEqual([]);
    expect(result.current.stats).toBeNull();
  });
});
