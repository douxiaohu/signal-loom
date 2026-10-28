import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import MessageCard from "../src/components/feed/MessageCard";
import type { Message } from "../src/types";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    chat_id: -1001,
    chat_title: "安全情报源",
    message_id: 10,
    sender_name: "值班员",
    message_time: "2026-07-13T08:00:00+00:00",
    content: "现场告警",
    media_type: null,
    media_urls: [],
    media_items: [],
    source_url: "https://t.me/example/10",
    ...overrides
  };
}

function renderCard(overrides: Partial<Message> = {}) {
  return render(<MessageCard density="reading" message={message(overrides)} onOpenImage={() => undefined} />);
}

/** Call after userEvent.setup(), which installs a clipboard stub of its own. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("MessageCard", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("copies the text and confirms it on the button", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard(vi.fn(async () => undefined));
    renderCard();

    await user.click(screen.getByRole("button", { name: "复制正文内容" }));

    expect(writeText).toHaveBeenCalledWith("现场告警");
    await waitFor(() => expect(screen.getByRole("button", { name: "复制正文内容" })).toHaveClass("is-done"));
  });

  it("copies the link to the original post", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard(vi.fn(async () => undefined));
    renderCard();

    await user.click(screen.getByRole("button", { name: "复制 Telegram 原文链接" }));

    expect(writeText).toHaveBeenCalledWith("https://t.me/example/10");
    await waitFor(() => expect(screen.getByRole("button", { name: "复制 Telegram 原文链接" })).toHaveClass("is-done"));
  });

  it("says so when the browser refuses to copy", async () => {
    const user = userEvent.setup();
    stubClipboard(vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }));
    renderCard();

    await user.click(screen.getByRole("button", { name: "复制正文内容" }));

    const failed = await screen.findByRole("button", { name: "复制失败" });
    expect(failed).toHaveAttribute("title", "复制失败，请手动选择文字");
    expect(failed).not.toHaveClass("is-done");
  });

  it("does not throw on a page without the async clipboard", async () => {
    const user = userEvent.setup();
    Reflect.deleteProperty(navigator, "clipboard");
    renderCard();

    await user.click(screen.getByRole("button", { name: "复制正文内容" }));

    expect(await screen.findByRole("button", { name: "复制失败" })).toBeInTheDocument();
  });

  it("offers only the actions that apply", () => {
    renderCard({ content: "", source_url: "", media_type: "photo", media_items: [{ url: "/p", kind: "image", role: "media" }] });

    expect(screen.queryByRole("button", { name: "复制正文内容" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制 Telegram 原文链接" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "原文" })).not.toBeInTheDocument();
    expect(screen.getByText("仅包含图片")).toBeInTheDocument();
  });

  it("shows the sender next to the source only when they differ", () => {
    const { unmount } = renderCard({ sender_name: "值班员" });
    expect(screen.getByText("· 值班员")).toBeInTheDocument();
    unmount();

    renderCard({ sender_name: "安全情报源" });
    expect(screen.queryByText(/· 安全情报源/)).not.toBeInTheDocument();
  });

  it("adds the console footer with the message number and media type", () => {
    render(<MessageCard density="console" message={message({ media_type: "photo" })} onOpenImage={() => undefined} />);

    expect(screen.getByText("消息 #10")).toBeInTheDocument();
    expect(screen.getByText("图片")).toHaveClass("media-badge");
  });
});
