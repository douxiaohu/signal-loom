import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import ErrorBoundary from "../src/components/ErrorBoundary";
import MessageFeed from "../src/components/MessageFeed";
import type { Message } from "../src/types";

function Boom(): never {
  throw new Error("渲染崩溃");
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("renders its children when nothing goes wrong", () => {
    render(<ErrorBoundary><p>正常内容</p></ErrorBoundary>);

    expect(screen.getByText("正常内容")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("replaces a crashed page with a notice and a way to reload", async () => {
    const onReload = vi.fn();
    render(<ErrorBoundary onReload={onReload}><Boom /></ErrorBoundary>);
    const user = userEvent.setup();

    expect(screen.getByRole("alert")).toHaveTextContent("页面遇到了意外错误，请刷新后重试。");
    await user.click(screen.getByRole("button", { name: "刷新页面" }));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("logs what crashed", () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);

    expect(console.error).toHaveBeenCalledWith("界面渲染失败", expect.objectContaining({ message: "渲染崩溃" }), expect.any(String));
  });

  it("can stand in a custom placeholder for just the broken part", () => {
    render(
      <div>
        <p>旁边的内容</p>
        <ErrorBoundary fallback={<p>这里坏了</p>}><Boom /></ErrorBoundary>
      </div>
    );

    expect(screen.getByText("旁边的内容")).toBeInTheDocument();
    expect(screen.getByText("这里坏了")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the rest of a message feed when one message cannot be rendered", () => {
    const fine = (id: number, content: string): Message => ({
      id, chat_id: -1, chat_title: "来源", message_id: id, sender_name: "编辑", message_time: "2026-07-14T08:00:00+00:00",
      content, media_type: null, media_urls: [], media_items: [], source_url: ""
    });
    const broken = { ...fine(2, "x"), content: null } as unknown as Message;

    render(
      <MessageFeed
        hasMore={false}
        initialLoading={false}
        loadingMore={false}
        messages={[fine(3, "第一条正常消息"), broken, fine(1, "第三条正常消息")]}
        onLoadMore={() => undefined}
      />
    );

    expect(screen.getByText("第一条正常消息")).toBeInTheDocument();
    expect(screen.getByText("这条消息无法显示")).toBeInTheDocument();
    expect(screen.getByText("第三条正常消息")).toBeInTheDocument();
  });
});
