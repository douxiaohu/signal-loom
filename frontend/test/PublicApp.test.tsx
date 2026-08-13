import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import PublicApp from "../src/PublicApp";


function json(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  }));
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
    expect(screen.getByRole("link", { name: "管理员入口" })).toHaveAttribute("href", "/admin");
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
});
