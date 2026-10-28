import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";

import type { AdminData } from "../../src/hooks/useAdminData";
import { operationKey, useOperationsActions } from "../../src/hooks/useOperationsActions";
import type { Group } from "../../src/types";
import { deferred, json, source, stubFetch } from "./helpers";

function fakeData(): AdminData {
  return {
    sources: [],
    alerts: [],
    rules: [],
    overview: null,
    sourceError: "",
    operationsError: "",
    loadSources: vi.fn(async () => undefined),
    loadOperations: vi.fn(async () => undefined),
    reportOperationsError: vi.fn(),
    clearOperationsError: vi.fn()
  };
}

function setup(overrides: { scopeChatId?: string; onUnauthorized?: (caught: unknown) => void } = {}) {
  const data = fakeData();
  const onStart = vi.fn();
  const onUnauthorized = overrides.onUnauthorized ?? vi.fn();
  const hook = renderHook(() => useOperationsActions({ data, scopeChatId: overrides.scopeChatId ?? "all", onUnauthorized, onStart }));
  return { ...hook, data, onStart, onUnauthorized };
}

const requestBody = (fetchMock: ReturnType<typeof stubFetch>, pathname: string) => {
  const call = fetchMock.mock.calls.find(([input]) => new URL(String(input), window.location.origin).pathname === pathname);
  return call?.[1]?.body ? JSON.parse(String(call[1].body)) : undefined;
};

describe("useOperationsActions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("runs the action, refreshes the operations data, announces the result and focuses its card", async () => {
    document.body.innerHTML = '<section id="alert-operations" tabindex="-1"></section>';
    const fetchMock = stubFetch((url) => (url.pathname === "/api/admin/matches/7/acknowledge" ? json({ id: 7 }) : undefined));
    const { result, data, onStart } = setup();

    await act(async () => { await result.current.handlers.onAcknowledge(7); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(data.clearOperationsError).toHaveBeenCalledTimes(1);
    expect(data.loadOperations).toHaveBeenCalledTimes(1);
    expect(data.loadSources).not.toHaveBeenCalled();
    expect(result.current.announcement).toBe("规则命中已确认");
    expect(document.activeElement).toBe(document.getElementById("alert-operations"));
  });

  it("reports its control as busy while it runs, and ignores a repeated click on it", async () => {
    const reply = deferred<Response>();
    const fetchMock = stubFetch((url) => (url.pathname === "/api/admin/matches/7/resolve" ? reply.promise : undefined));
    const { result } = setup();

    let first!: Promise<void>;
    act(() => {
      first = result.current.handlers.onResolve(7);
      void result.current.handlers.onResolve(7);
    });
    expect(result.current.busy.has(operationKey.alert(7))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    reply.resolve(await json({ id: 7 }));
    await act(async () => { await first; });
    expect(result.current.busy.size).toBe(0);
  });

  it("lets actions on different controls run side by side", async () => {
    const replies = [deferred<Response>(), deferred<Response>()];
    const fetchMock = stubFetch((url) => {
      if (url.pathname === "/api/admin/matches/7/acknowledge") return replies[0].promise;
      if (url.pathname === "/api/admin/matches/8/acknowledge") return replies[1].promise;
      return undefined;
    });
    const { result } = setup();

    let both!: Promise<unknown>;
    act(() => { both = Promise.all([result.current.handlers.onAcknowledge(7), result.current.handlers.onAcknowledge(8)]); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...result.current.busy].sort()).toEqual([operationKey.alert(7), operationKey.alert(8)]);

    replies[0].resolve(await json({ id: 7 }));
    replies[1].resolve(await json({ id: 8 }));
    await act(async () => { await both; });
    expect(result.current.busy.size).toBe(0);
  });

  it.each([
    [{ public_visible: true }, "来源已公开"],
    [{ public_visible: false }, "来源已设为私有"],
    [{ enabled: true }, "来源采集已启用"],
    [{ enabled: false }, "来源采集已停用"]
  ])("patches a source with %j, reloads the sources and announces it", async (payload, message) => {
    const fetchMock = stubFetch((url) => (url.pathname === "/api/admin/sources/-1001" ? json(source(-1001, "来源")) : undefined));
    const { result, data } = setup();

    await act(async () => { await result.current.handlers.onPatchSource(source(-1001, "来源") as unknown as Group, payload); });

    expect(requestBody(fetchMock, "/api/admin/sources/-1001")).toEqual(payload);
    expect(data.loadSources).toHaveBeenCalledTimes(1);
    expect(data.loadOperations).toHaveBeenCalledTimes(1);
    expect(result.current.announcement).toBe(message);
  });

  it("announces a crawl while it runs, since it can take a minute, and again when it is done", async () => {
    const reply = deferred<Response>();
    stubFetch((url) => (url.pathname === "/api/admin/sources/-1001/crawl-now" ? reply.promise : undefined));
    const { result } = setup();

    let crawl!: Promise<void>;
    act(() => { crawl = result.current.handlers.onCrawlSource(-1001); });
    expect(result.current.announcement).toBe("正在采集来源，最长约需 90 秒");
    expect(result.current.busy.has(operationKey.crawl(-1001))).toBe(true);

    reply.resolve(await json({ ok: true }));
    await act(async () => { await crawl; });
    expect(result.current.announcement).toBe("已完成一次来源采集");
  });

  it("reports a failure, hands it to onUnauthorized and frees the control", async () => {
    stubFetch((url) => (url.pathname === "/api/admin/matches/7/resolve" ? json({ detail: "数据库繁忙" }, 503) : undefined));
    const { result, data, onUnauthorized } = setup();

    await act(async () => { await result.current.handlers.onResolve(7); });

    expect(data.reportOperationsError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(data.reportOperationsError).mock.calls[0][0]).toMatchObject({ status: 503, message: "数据库繁忙" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(data.loadOperations).not.toHaveBeenCalled();
    expect(result.current.announcement).toBe("");
    expect(result.current.busy.size).toBe(0);
  });

  it("rethrows a failed creation so the form can show it too", async () => {
    stubFetch((url) => (url.pathname === "/api/admin/rules" ? json({ detail: "规则重复" }, 409) : undefined));
    const { result, data } = setup();

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.handlers.onCreateRule("规则", "关键词");
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toMatchObject({ status: 409, message: "规则重复" });
    expect(data.reportOperationsError).toHaveBeenCalledTimes(1);
    expect(result.current.busy.size).toBe(0);
  });

  it("limits a new rule to the source the filters are on", async () => {
    const fetchMock = stubFetch((url) => (url.pathname === "/api/admin/rules" ? json({ id: 1 }) : undefined));
    const scoped = setup({ scopeChatId: "-1001" });
    await act(async () => { await scoped.result.current.handlers.onCreateRule("规则", "漏洞"); });
    expect(requestBody(fetchMock, "/api/admin/rules")).toMatchObject({ name: "规则", keyword: "漏洞", enabled: false, source_ids: [-1001] });

    fetchMock.mockClear();
    const everywhere = setup({ scopeChatId: "all" });
    await act(async () => { await everywhere.result.current.handlers.onCreateRule("规则", "漏洞"); });
    expect(requestBody(fetchMock, "/api/admin/rules")).toMatchObject({ source_ids: [] });
  });

  it("creates a source, reloading the source list first", async () => {
    stubFetch((url) => (url.pathname === "/api/admin/sources" ? json(source(-5, "新来源")) : undefined));
    const { result, data } = setup();

    await act(async () => { await result.current.handlers.onCreateSource("新来源", "https://t.me/new"); });

    expect(data.loadSources).toHaveBeenCalledTimes(1);
    expect(result.current.announcement).toBe("来源已添加，默认仅管理员可见");
  });

  it("clears the announcement on request", async () => {
    stubFetch((url) => (url.pathname === "/api/admin/matches/7/acknowledge" ? json({ id: 7 }) : undefined));
    const { result } = setup();
    await act(async () => { await result.current.handlers.onAcknowledge(7); });
    expect(result.current.announcement).not.toBe("");

    act(() => result.current.clearAnnouncement());
    expect(result.current.announcement).toBe("");
  });
});
