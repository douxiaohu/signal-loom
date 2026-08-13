import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import App from "../src/App";

const group = {
  chat_id: -1001,
  name: "安全情报源",
  source: "https://t.me/example",
  source_url: "https://t.me/example",
  source_type: "public",
  enabled: true,
  public_visible: true,
  message_count: 2,
  pending_count: 1,
  last_message_time: "2026-07-13T08:00:00+00:00",
  health_status: "healthy",
  last_run_at: "2026-07-13T08:01:00+00:00",
  last_success_at: "2026-07-13T08:01:00+00:00",
  last_error: null,
  fetched_count: 2,
  saved_count: 1
};

function message(id: number, content: string) {
  return {
    id,
    chat_id: -1001,
    chat_title: "安全情报源",
    message_id: id,
    sender_name: "值班员",
    message_time: `2026-07-13T08:0${id}:00+00:00`,
    content,
    media_type: null,
    media_urls: [],
    media_items: [],
    source_url: "",
    forwarded_at: null
  };
}

function json(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }));
}

function installBaseFetch(
  messageHandler: (url: URL, init?: RequestInit) => Promise<Response>,
  routeHandler?: (url: URL, init?: RequestInit) => Promise<Response> | undefined
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      const customResponse = routeHandler?.(url, init);
      if (customResponse) return customResponse;
      if (url.pathname === "/api/session") return json({ authenticated: true, expires_at: 1_800_000_000 });
      if (url.pathname === "/api/admin/sources") return json({ items: [group] });
      if (url.pathname === "/api/admin/operations/summary") {
        return json({ generated_at: new Date().toISOString(), sources: [group], unhealthy_sources: [], public_source_count: 1, source_count: 1 });
      }
      if (url.pathname === "/api/admin/matches" || url.pathname === "/api/admin/rules") return json({ items: [] });
      if (url.pathname === "/api/admin/messages") return messageHandler(url, init);
      throw new Error(`Unexpected request: ${url.pathname}`);
    })
  );
}

describe("App", () => {
  it("shows the management login gate and enters the admin center without delivery calls", async () => {
    let authenticated = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/session") return json({ authenticated, expires_at: authenticated ? 1_800_000_000 : null });
        if (url.pathname === "/api/auth/login") {
          authenticated = true;
          return json({ authenticated: true, expires_at: 1_800_000_000 });
        }
        if (url.pathname === "/api/admin/sources") return json({ items: [group] });
        if (url.pathname === "/api/admin/messages") return json({ items: [], has_more: false, next_cursor: null, total: null });
        if (url.pathname === "/api/admin/operations/summary") return json({ sources: [group], unhealthy_sources: [], public_source_count: 1, source_count: 1 });
        if (["/api/admin/matches", "/api/admin/rules"].includes(url.pathname)) return json({ items: [] });
        throw new Error(`Unexpected request: ${url.pathname}`);
      })
    );

    render(<App />);
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "管理中心" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("管理密钥"), "correct-key");
    await user.click(screen.getByRole("button", { name: "进入管理中心" }));
    expect(await screen.findByRole("heading", { name: "管理中心" })).toBeInTheDocument();
    const paths = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input), window.location.origin).pathname);
    expect(paths).not.toContain("/api/deliveries");
  });

  it("distinguishes a login service failure from an invalid key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/session") return json({ authenticated: false, expires_at: null });
        if (url.pathname === "/api/auth/login") return json({ detail: "upstream unavailable" }, 503);
        throw new Error(`Unexpected request: ${url.pathname}`);
      })
    );
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("管理密钥"), "some-key");
    await user.click(screen.getByRole("button", { name: "进入管理中心" }));
    expect(await screen.findByText("登录服务暂时不可用，请检查网络或服务状态后重试。")).toBeInTheDocument();
  });

  it("keeps the newest committed filter result when an older request finishes last", async () => {
    window.history.replaceState(null, "", "/?query=旧条件");
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    installBaseFetch((url) => {
      if (url.searchParams.get("query") === "旧条件") return oldResponse;
      return json({ items: [message(2, "新条件结果")], has_more: false, next_cursor: null, total: null });
    });

    render(<App />);
    const user = userEvent.setup();
    const input = await screen.findByLabelText("关键词");
    await user.clear(input);
    await user.type(input, "新条件");
    await user.click(screen.getByRole("button", { name: "应用筛选" }));
    expect(await screen.findByText("新条件结果")).toBeInTheDocument();

    resolveOld(await json({ items: [message(1, "旧条件结果")], has_more: false, next_cursor: null, total: null }));
    await waitFor(() => expect(screen.queryByText("旧条件结果")).not.toBeInTheDocument());
    expect(screen.getByText("新条件结果")).toBeInTheDocument();
  });

  it("deduplicates message ids when loading the same cursor page", async () => {
    installBaseFetch((url) => {
      if (url.searchParams.get("cursor") === "next") {
        return json({ items: [message(1, "第一条"), message(2, "第二条")], has_more: false, next_cursor: null, total: null });
      }
      return json({ items: [message(1, "第一条")], has_more: true, next_cursor: "next", total: null });
    });

    render(<App />);
    const user = userEvent.setup();
    await screen.findByText("第一条");
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("第二条")).toBeInTheDocument();
    expect(screen.getAllByText("第一条")).toHaveLength(1);
  });

  it("commits filters to the URL and restores them on browser navigation", async () => {
    installBaseFetch(() => json({ items: [], has_more: false, next_cursor: null, total: null }));
    render(<App />);
    const user = userEvent.setup();
    const query = await screen.findByLabelText("关键词");
    await user.type(query, "漏洞通报");
    await user.selectOptions(screen.getByLabelText("媒体类型"), "document");
    await user.click(screen.getByRole("button", { name: "应用筛选" }));
    expect(window.location.search).toBe("?media=document&query=%E6%BC%8F%E6%B4%9E%E9%80%9A%E6%8A%A5");

    await act(async () => {
      window.history.pushState(null, "", "/?query=返回条件");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.getByLabelText("关键词")).toHaveValue("返回条件"));
    expect(screen.getByLabelText("媒体类型")).toHaveValue("all");
  });

  it("announces new messages during the 60 second check without replacing the feed", async () => {
    let messageCalls = 0;
    let messagePoll: TimerHandler | undefined;
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, "setInterval").mockImplementation((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 60_000) messagePoll = handler;
      return realSetInterval(() => undefined, 2_000_000, ...args);
    });
    installBaseFetch(() => {
      messageCalls += 1;
      return json({ items: messageCalls === 1 ? [message(1, "当前消息")] : [message(2, "后台新消息"), message(1, "当前消息")], has_more: false, next_cursor: null, total: null });
    });

    render(<App />);
    expect(await screen.findByText("当前消息")).toBeInTheDocument();
    expect(messagePoll).toBeTypeOf("function");
    await act(async () => {
      if (typeof messagePoll === "function") messagePoll();
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "1 条新消息，点击显示" })).toBeInTheDocument();
    expect(screen.queryByText("后台新消息")).not.toBeInTheDocument();
  });

  it("refreshes source health every 30 seconds and pauses while the page is hidden", async () => {
    let healthPoll: TimerHandler | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler: TimerHandler, timeout?: number) => {
      if (timeout === 30_000) healthPoll = handler;
      return 1;
    });
    installBaseFetch(() => json({ items: [], has_more: false, next_cursor: null, total: null }));
    render(<App />);
    await screen.findByRole("heading", { name: "管理中心" });
    const fetchMock = vi.mocked(fetch);
    const sourceCalls = () => fetchMock.mock.calls.filter(([input]) => new URL(String(input), window.location.origin).pathname === "/api/admin/sources").length;
    await waitFor(() => expect(sourceCalls()).toBe(1));

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    if (typeof healthPoll === "function") healthPoll();
    await Promise.resolve();
    expect(sourceCalls()).toBe(1);

    visibility.mockReturnValue("visible");
    await act(async () => {
      if (typeof healthPoll === "function") healthPoll();
      await Promise.resolve();
    });
    await waitFor(() => expect(sourceCalls()).toBe(2));
  });

  it("keeps the active console session and announces an error when logout fails", async () => {
    installBaseFetch(
      () => json({ items: [], has_more: false, next_cursor: null, total: null }),
      (url) => url.pathname === "/api/auth/logout" ? json({ detail: "service unavailable" }, 503) : undefined
    );
    render(<App />);
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "管理中心" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "退出" }));

    expect(await screen.findByText(/退出失败，当前会话仍保持有效/, { selector: ".single-live-region" })).toBeInTheDocument();
    expect(screen.getByText("退出失败", { selector: ".inline-error strong" })).toBeInTheDocument();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "管理中心" })).toBeInTheDocument();
  });

  it("announces a successful alert action and moves focus to its stable result card", async () => {
    let alertStatus = "new";
    const alert = () => ({
      id: 7,
      rule_id: 3,
      rule_name: "高危漏洞",
      keyword: "漏洞",
      status: alertStatus,
      matched_at: "2026-07-13T08:02:00+00:00",
      chat_title: "安全情报源",
      sender_name: "值班员",
      message_time: "2026-07-13T08:01:00+00:00",
      content: "高危漏洞通报",
      media_type: null
    });
    installBaseFetch(
      () => json({ detail: "message feed unavailable" }, 503),
      (url) => {
        if (url.pathname === "/api/admin/matches/7/acknowledge") {
          alertStatus = "acknowledged";
          return json(alert());
        }
        if (url.pathname === "/api/admin/matches") return json({ items: [alert()] });
        return undefined;
      }
    );
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "确认" }));

    expect(await screen.findByText("规则命中已确认", { selector: ".single-live-region" })).toBeInTheDocument();
    const alertCard = screen.getByRole("region", { name: "规则命中" });
    await waitFor(() => expect(alertCard).toHaveFocus());
  });
});
