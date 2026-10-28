import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import PublicApp from "../src/PublicApp";


function json(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  }));
}


function publicMessage(id: number, chatId: number, content: string) {
  return {
    id,
    chat_id: chatId,
    chat_title: `来源${Math.abs(chatId)}`,
    message_id: id,
    sender_name: "编辑",
    message_time: "2026-07-14T08:00:00+00:00",
    content,
    media_type: null,
    media_urls: [],
    media_items: [],
    source_url: ""
  };
}

function publicSource(chatId: number, name: string) {
  return { chat_id: chatId, name, source_url: `https://t.me/s${Math.abs(chatId)}`, message_count: 1, last_message_time: null, health_status: "healthy" };
}

function pageOf(items: unknown[], extra: { has_more?: boolean; next_cursor?: string | null } = {}) {
  return { items, has_more: false, next_cursor: null, total: null, ...extra };
}

/** Serves the two sources and lets each test decide what /api/public/messages answers. */
function stubPublicApi(messages: (url: URL) => Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === "/api/public/sources") return json({ items: [publicSource(-1, "来源一"), publicSource(-2, "来源二")] });
    if (url.pathname === "/api/public/messages") return messages(url);
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof stubPublicApi>, pathname: string) {
  return fetchMock.mock.calls.filter(([input]) => new URL(String(input), window.location.origin).pathname === pathname).length;
}

describe("PublicApp", () => {
  it("loads the public timeline without requesting a session", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/public/sources") {
        return json({ items: [{
          chat_id: -1001,
          name: "竹新社",
          source_url: "https://t.me/tnews365",
          message_count: 1,
          last_message_time: "2026-07-14T08:00:00+00:00",
          health_status: "healthy"
        }] });
      }
      if (url.pathname === "/api/public/messages") {
        return json({
          items: [{
            id: 1,
            chat_id: -1001,
            chat_title: "竹新社",
            message_id: 10,
            sender_name: "编辑",
            message_time: "2026-07-14T08:00:00+00:00",
            content: "公开频道消息",
            media_type: null,
            media_urls: [],
            media_items: [],
            source_url: "https://t.me/tnews365/10"
          }],
          has_more: false,
          next_cursor: null,
          total: null
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    render(<PublicApp />);

    expect(await screen.findByRole("heading", { name: "频道资讯" })).toBeInTheDocument();
    expect(await screen.findByText("公开频道消息")).toBeInTheDocument();
    expect(screen.queryByLabelText("管理密钥")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "管理员入口" })).not.toBeInTheDocument();
    await waitFor(() => {
      const paths = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input), window.location.origin).pathname);
      expect(paths).not.toContain("/api/session");
    });
  });

  it("clears the previous source immediately while an uncached source loads", async () => {
    let resolveSecond!: (response: Response) => void;
    const secondPage = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/public/sources") return json({ items: [
        { chat_id: -1, name: "来源一", source_url: "https://t.me/one", message_count: 1, last_message_time: null, health_status: "healthy" },
        { chat_id: -2, name: "来源二", source_url: "https://t.me/two", message_count: 1, last_message_time: null, health_status: "healthy" }
      ] });
      if (url.pathname === "/api/public/messages" && url.searchParams.get("chat_id") === "-2") return secondPage;
      if (url.pathname === "/api/public/messages") return json({
        items: [{ id: 1, chat_id: -1, chat_title: "来源一", message_id: 1, sender_name: "A", message_time: "2026-07-14T08:00:00+00:00", content: "旧来源消息", media_type: null, media_urls: [], media_items: [], source_url: "" }],
        has_more: false, next_cursor: null, total: null
      });
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    render(<PublicApp />);
    const user = userEvent.setup();
    expect(await screen.findByText("旧来源消息")).toBeInTheDocument();
    await user.click(await screen.findByRole("radio", { name: /来源二/ }));

    expect(screen.queryByText("旧来源消息")).not.toBeInTheDocument();
    expect(screen.getByLabelText("正在加载来源二消息")).toBeInTheDocument();

    resolveSecond(await json({ items: [], has_more: false, next_cursor: null, total: null }));
  });

  it("shows a cached source immediately and revalidates it in the background", async () => {
    let allCalls = 0;
    let resolveRevalidation!: (response: Response) => void;
    const revalidation = new Promise<Response>((resolve) => { resolveRevalidation = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/public/sources") return json({ items: [
        { chat_id: -2, name: "来源二", source_url: "https://t.me/two", message_count: 1, last_message_time: null, health_status: "healthy" }
      ] });
      if (url.pathname === "/api/public/messages" && url.searchParams.get("chat_id") === "-2") return json({
        items: [{ id: 2, chat_id: -2, chat_title: "来源二", message_id: 2, sender_name: "B", message_time: "2026-07-14T08:01:00+00:00", content: "来源二消息", media_type: null, media_urls: [], media_items: [], source_url: "" }],
        has_more: false, next_cursor: null, total: null
      });
      if (url.pathname === "/api/public/messages") {
        allCalls += 1;
        if (allCalls === 2) return revalidation;
        return json({
          items: [{ id: 1, chat_id: -1, chat_title: "全部", message_id: 1, sender_name: "A", message_time: "2026-07-14T08:00:00+00:00", content: "全部来源缓存消息", media_type: null, media_urls: [], media_items: [], source_url: "" }],
          has_more: false, next_cursor: null, total: null
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    render(<PublicApp />);
    const user = userEvent.setup();
    expect(await screen.findByText("全部来源缓存消息")).toBeInTheDocument();
    await user.click(await screen.findByRole("radio", { name: /来源二/ }));
    expect(await screen.findByText("来源二消息")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /全部公开来源/ }));

    expect(screen.getByText("全部来源缓存消息")).toBeInTheDocument();
    expect(screen.getByText("正在更新…")).toBeInTheDocument();
    expect(allCalls).toBe(2);

    resolveRevalidation(await json({ items: [], has_more: false, next_cursor: null, total: null }));
  });

  it("does not append a late 'load more' page of the previous source to the next one", async () => {
    let resolveMore!: (response: Response) => void;
    const lateMore = new Promise<Response>((resolve) => { resolveMore = resolve; });
    stubPublicApi((url) => {
      if (url.searchParams.get("cursor") === "c1") return lateMore;
      if (url.searchParams.get("chat_id") === "-2") return json(pageOf([publicMessage(20, -2, "来源二消息")]));
      return json(pageOf([publicMessage(10, -1, "全部来源首页")], { has_more: true, next_cursor: "c1" }));
    });

    render(<PublicApp />);
    const user = userEvent.setup();
    expect(await screen.findByText("全部来源首页")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    await user.click(await screen.findByRole("radio", { name: /来源二/ }));
    expect(await screen.findByText("来源二消息")).toBeInTheDocument();

    await act(async () => { resolveMore(await json(pageOf([publicMessage(11, -1, "迟到的下一页")]))); });

    expect(screen.queryByText("迟到的下一页")).not.toBeInTheDocument();
    expect(screen.getByText("来源二消息")).toBeInTheDocument();
  });

  it("explains why 'load more' failed and keeps the messages already listed", async () => {
    stubPublicApi((url) => {
      if (url.searchParams.get("cursor") === "c1") return json({ detail: "数据库繁忙" }, 503);
      return json(pageOf([publicMessage(10, -1, "已加载消息")], { has_more: true, next_cursor: "c1" }));
    });

    render(<PublicApp />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "加载更多" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("数据库繁忙");
    expect(screen.getByText("已加载消息")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加载更多" })).toBeEnabled();
  });

  it("falls back to every public source when a bookmarked source no longer exists", async () => {
    window.history.replaceState(null, "", "/?chat_id=-999&media=photo");
    const pushState = vi.spyOn(window.history, "pushState");
    stubPublicApi((url) => {
      if (url.searchParams.get("chat_id") === "-999") return json({ detail: "Source not found" }, 404);
      return json(pageOf([publicMessage(1, -1, "全部来源消息")]));
    });

    render(<PublicApp />);
    const user = userEvent.setup();

    expect(await screen.findByText("全部来源消息")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("所选来源不存在或未公开，已切换到全部公开来源");
    expect(window.location.search).toBe("?media=photo");
    expect(pushState).not.toHaveBeenCalled(); // corrected in place, so "back" does not return to the dead link

    await user.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps showing the error of a failing source when it is already on 'all'", async () => {
    stubPublicApi(() => json({ detail: "Source not found" }, 404));

    render(<PublicApp />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Source not found");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("reports a failing source list without blocking the messages", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/public/sources") return json({ detail: "来源服务异常" }, 500);
      if (url.pathname === "/api/public/messages") return json(pageOf([publicMessage(1, -1, "仍然可读的消息")]));
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    render(<PublicApp />);

    expect(await screen.findByText("仍然可读的消息")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("来源服务异常");
  });

  it("refreshes sources and messages from the server when the refresh button is used", async () => {
    const fetchMock = stubPublicApi(() => json(pageOf([publicMessage(1, -1, "消息一")])));

    render(<PublicApp />);
    const user = userEvent.setup();
    await screen.findByText("消息一");
    expect(callsTo(fetchMock, "/api/public/messages")).toBe(1);

    await user.click(screen.getByRole("button", { name: "刷新资讯" }));

    await waitFor(() => expect(callsTo(fetchMock, "/api/public/messages")).toBe(2));
    expect(callsTo(fetchMock, "/api/public/sources")).toBe(2);
    expect(await screen.findByText("消息一")).toBeInTheDocument();
  });

  it("searching again for the same keyword refetches without adding a history entry", async () => {
    const fetchMock = stubPublicApi(() => json(pageOf([publicMessage(1, -1, "消息一")])));

    render(<PublicApp />);
    const user = userEvent.setup();
    await screen.findByText("消息一");
    await user.type(screen.getByLabelText("检索资讯关键词"), "漏洞");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(callsTo(fetchMock, "/api/public/messages")).toBe(2));
    const entries = window.history.length;

    await user.click(screen.getByRole("button", { name: "搜索" }));

    await waitFor(() => expect(callsTo(fetchMock, "/api/public/messages")).toBe(3));
    expect(window.history.length).toBe(entries);
    expect(window.location.search).toBe("?query=%E6%BC%8F%E6%B4%9E");
  });

  it("puts the restored keyword and media type back into the controls on back/forward", async () => {
    stubPublicApi(() => json(pageOf([publicMessage(1, -1, "消息一")])));

    render(<PublicApp />);
    await screen.findByText("消息一");
    await act(async () => {
      window.history.pushState(null, "", "/?media=document&query=返回条件");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByLabelText("检索资讯关键词")).toHaveValue("返回条件");
    expect(screen.getByRole("button", { name: "文件" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "false");
  });
});
