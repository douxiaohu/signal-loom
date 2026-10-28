import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import ImageViewer from "../src/components/ImageViewer";
import MessageFeed from "../src/components/MessageFeed";
import type { Message } from "../src/types";


const photoMessage: Message = {
  id: 8,
  chat_id: -1001,
  chat_title: "竹新社",
  message_id: 80,
  sender_name: "编辑",
  message_time: "2026-07-14T08:00:00+00:00",
  content: "完整图片测试",
  media_type: "photo",
  media_urls: ["/api/public/media/8/0?variant=thumbnail"],
  media_items: [{
    url: "/api/public/media/8/0?variant=thumbnail",
    original_url: "/api/public/media/8/0?variant=original",
    kind: "image",
    role: "media"
  }],
  source_url: "https://t.me/tnews365/80"
};


describe("ImageViewer", () => {
  it("opens the original image and restores focus after Escape", async () => {
    render(
      <MessageFeed
        hasMore={false}
        initialLoading={false}
        loadingMore={false}
        messages={[photoMessage]}
        onLoadMore={() => undefined}
      />
    );
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "查看完整图片 1" });

    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "图片预览" });
    expect(dialog).toBeInTheDocument();
    expect(dialog.parentElement).toBe(document.body);
    expect(screen.getByRole("img", { name: "竹新社中编辑发布的完整图片 1" })).toHaveAttribute(
      "src",
      "/api/public/media/8/0?variant=original"
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes from the close button or the darkened backdrop", async () => {
    render(
      <MessageFeed
        hasMore={false}
        initialLoading={false}
        loadingMore={false}
        messages={[photoMessage]}
        onLoadMore={() => undefined}
      />
    );
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "查看完整图片 1" });

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "关闭图片预览" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(trigger);
    await user.click(screen.getByRole("dialog", { name: "图片预览" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("uses the contained image class and omits delivery status", () => {
    render(
      <MessageFeed
        hasMore={false}
        initialLoading={false}
        loadingMore={false}
        messages={[photoMessage]}
        onLoadMore={() => undefined}
      />
    );

    expect(screen.getByAltText("竹新社中编辑发布的图片 1")).toHaveClass("media-image-contained");
    expect(screen.queryByText("待投递")).not.toBeInTheDocument();
    expect(screen.queryByText("已投递")).not.toBeInTheDocument();
  });

  it("is not disturbed when its parent re-renders with a new onClose", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const returnFocusRef = { current: trigger };
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<ImageViewer src="/a" alt="图" returnFocusRef={returnFocusRef} onClose={first} />);
    expect(screen.getByRole("button", { name: "关闭图片预览" })).toHaveFocus();
    const download = screen.getByRole("link", { name: /下载/ });
    download.focus();

    rerender(<ImageViewer src="/a" alt="图" returnFocusRef={returnFocusRef} onClose={second} />);

    // The effect did not restart: focus was neither sent back to the page nor pulled to the close button.
    expect(download).toHaveFocus();
    expect(document.body).toHaveClass("viewer-open");

    await userEvent.setup().keyboard("{Escape}");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    trigger.remove();
  });
});
