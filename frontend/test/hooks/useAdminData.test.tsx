import { act, renderHook, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { useAdminData } from "../../src/hooks/useAdminData";
import { ApiError } from "../../src/lib/http";
import { EMPTY_STATS, callsTo, deferred, json, source, stubFetch } from "./helpers";

type Route = (url: URL) => Promise<Response> | undefined;

/** The five endpoints the console polls, each overridable per test. */
function adminApi(overrides: Record<string, Route> = {}) {
  return stubFetch((url) => {
    const override = overrides[url.pathname]?.(url);
    if (override) return override;
    switch (url.pathname) {
      case "/api/admin/sources":
        return json({ items: [source(-1, "来源一"), source(-2, "来源二")] });
      case "/api/admin/operations/summary":
        return json({
          sources: [
            { ...source(-1, "来源一"), consecutive_failures: 2, new_message_volume: 0 },
            { ...source(-2, "来源二"), consecutive_failures: 0, new_message_volume: 7 }
          ],
          unhealthy_sources: []
        });
      case "/api/admin/matches":
      case "/api/admin/rules":
        return json({ items: [] });
      case "/api/admin/overview":
        return json({ visits: EMPTY_STATS, sources: { total: 2, enabled: 2, public: 2, unhealthy: 0, items: [] }, alerts: { new_count: 0 } });
      default:
        return undefined;
    }
  });
}

function setup(authenticated = true, onUnauthorized: (caught: unknown) => void = vi.fn()) {
  return renderHook((props: { authenticated: boolean }) => useAdminData({ authenticated: props.authenticated, onUnauthorized }), {
    initialProps: { authenticated }
  });
}

describe("useAdminData", () => {
  it("loads nothing before sign-in and everything after it", async () => {
    const fetchMock = adminApi();
    const { result, rerender } = setup(false);
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.sources).toEqual([]);

    rerender({ authenticated: true });

    await waitFor(() => expect(result.current.sources).toHaveLength(2));
    await waitFor(() => expect(result.current.overview).not.toBeNull());
    expect(callsTo(fetchMock, "/api/admin/matches")).toBe(1);
    expect(callsTo(fetchMock, "/api/admin/rules")).toBe(1);
  });

  it("adds each source's anomaly stats from the operations summary", async () => {
    adminApi();
    const { result } = setup();

    await waitFor(() => expect(result.current.sources[0]?.consecutive_failures).toBe(2));
    expect(result.current.sources.map((item) => [item.chat_id, item.consecutive_failures, item.new_message_volume])).toEqual([
      [-1, 2, 0],
      [-2, 0, 7]
    ]);
  });

  it("lists sources without stats while the summary is still on its way", async () => {
    const summary = deferred<Response>();
    adminApi({ "/api/admin/operations/summary": () => summary.promise });
    const { result } = setup();

    await waitFor(() => expect(result.current.sources).toHaveLength(2));
    expect(result.current.sources[0].consecutive_failures).toBeUndefined();

    summary.resolve(await json({ sources: [{ ...source(-1, "来源一"), consecutive_failures: 3, new_message_volume: 1 }], unhealthy_sources: [] }));
    await waitFor(() => expect(result.current.sources[0].consecutive_failures).toBe(3));
    expect(result.current.sources[1].consecutive_failures).toBeUndefined(); // not in the summary
  });

  it("forgets everything on sign-out and ignores answers that were still on their way", async () => {
    const lateSources = deferred<Response>();
    let first = true;
    adminApi({
      "/api/admin/sources": () => {
        if (first) {
          first = false;
          return undefined; // the default answer
        }
        return lateSources.promise;
      }
    });
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.sources).toHaveLength(2));
    await waitFor(() => expect(result.current.overview).not.toBeNull());

    let refresh!: Promise<void>;
    act(() => { refresh = result.current.loadSources(); });
    rerender({ authenticated: false });
    expect(result.current.sources).toEqual([]);
    expect(result.current.overview).toBeNull();

    lateSources.resolve(await json({ items: [source(-9, "上一个会话的来源")] }));
    await act(async () => { await refresh; });
    expect(result.current.sources).toEqual([]);
  });

  it("lets the newest sources request win when an older one answers last", async () => {
    const older = deferred<Response>();
    let calls = 0;
    adminApi({
      "/api/admin/sources": () => {
        calls += 1;
        if (calls === 1) return json({ items: [source(-1, "初始")] });
        if (calls === 2) return older.promise;
        return json({ items: [source(-1, "最新")] });
      }
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.sources[0]?.name).toBe("初始"));

    let slow!: Promise<void>;
    act(() => { slow = result.current.loadSources(); });
    await act(async () => { await result.current.loadSources(); });
    expect(result.current.sources[0].name).toBe("最新");

    older.resolve(await json({ items: [source(-1, "过期")] }));
    await act(async () => { await slow; });
    expect(result.current.sources[0].name).toBe("最新");
  });

  it("keeps an error on screen through a scheduled refresh but clears it when the user retries", async () => {
    const scheduled = deferred<Response>();
    const retry = deferred<Response>();
    let calls = 0;
    adminApi({
      "/api/admin/sources": () => {
        calls += 1;
        if (calls === 1) return json({ detail: "数据库繁忙" }, 503);
        return calls === 2 ? scheduled.promise : retry.promise;
      }
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.sourceError).toContain("数据库繁忙"));

    act(() => { void result.current.loadSources({ background: true }); });
    expect(result.current.sourceError).toContain("数据库繁忙"); // no blinking

    act(() => { void result.current.loadSources(); });
    expect(result.current.sourceError).toBe(""); // the retry gives immediate feedback
    retry.resolve(await json({ items: [source(-1, "来源一")] }));
    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    expect(result.current.sourceError).toBe("");
  });

  it("shows what did load and the first error when only part of the operations data fails", async () => {
    adminApi({ "/api/admin/overview": () => json({ detail: "概览暂不可用" }, 500) });
    const { result } = setup();

    await waitFor(() => expect(result.current.operationsError).toContain("概览暂不可用"));
    await waitFor(() => expect(result.current.sources[0]?.consecutive_failures).toBe(2));
    expect(result.current.overview).toBeNull();
  });

  it("hands 401 answers to onUnauthorized", async () => {
    adminApi({ "/api/admin/sources": () => json({ detail: "expired" }, 401) });
    const onUnauthorized = vi.fn();
    setup(true, onUnauthorized);

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    expect(onUnauthorized.mock.calls[0][0]).toBeInstanceOf(ApiError);
    expect(onUnauthorized.mock.calls[0][0]).toMatchObject({ status: 401 });
  });

  it("reports and clears operation errors on request", async () => {
    adminApi();
    const { result } = setup();
    await waitFor(() => expect(result.current.sources).toHaveLength(2));

    act(() => result.current.reportOperationsError(new Error("规则保存失败")));
    expect(result.current.operationsError).toContain("规则保存失败");
    act(() => result.current.clearOperationsError());
    expect(result.current.operationsError).toBe("");
  });

  it("refreshes every 30 seconds while signed in, and stops when signed out", async () => {
    const fetchMock = adminApi();
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.overview).not.toBeNull());
    expect(callsTo(fetchMock, "/api/admin/sources")).toBe(1);

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    rerender({ authenticated: true }); // restart the polling effect under fake timers
    rerender({ authenticated: false });
    rerender({ authenticated: true });
    const before = callsTo(fetchMock, "/api/admin/sources");

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(callsTo(fetchMock, "/api/admin/sources")).toBe(before + 1);

    rerender({ authenticated: false });
    const afterSignOut = callsTo(fetchMock, "/api/admin/sources");
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(callsTo(fetchMock, "/api/admin/sources")).toBe(afterSignOut);
  });
});
