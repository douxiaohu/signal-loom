import { render, screen } from "@testing-library/react";

import MessageFeed from "../src/components/MessageFeed";
import type { Message } from "../src/types";

function message(overrides: Partial<Message>): Message {
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
    forwarded_at: null,
    ...overrides
  };
}

describe("MessageFeed", () => {
  it("renders image, video, file and audio with accurate semantics", () => {
    render(
      <MessageFeed
        hasMore={false}
        initialLoading={false}
        loadingMore={false}
        messages={[
          message({ id: 1, media_type: "photo", media_items: [{ url: "/photo", kind: "image", role: "media" }] }),
          message({ id: 2, message_id: 11, media_type: "video", media_items: [{ url: "/video", kind: "video", role: "media" }] }),
          message({ id: 3, message_id: 12, media_type: "document", media_items: [{ url: "/report.pdf", kind: "document", role: "media" }] }),
          message({ id: 4, message_id: 13, media_type: "audio", media_items: [{ url: "/audio", kind: "audio", role: "media" }] })
        ]}
        onLoadMore={() => undefined}
      />
    );

    expect(screen.getByAltText("安全情报源中值班员发布的图片 1")).toBeInTheDocument();
    expect(screen.getByLabelText("安全情报源中的视频")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载文件" })).toHaveAttribute("href", "/report.pdf");
    expect(screen.getByLabelText("安全情报源中的音频")).toHaveClass("audio-control");
  });

  it("disables pagination while a cursor request is running", () => {
    render(
      <MessageFeed
        hasMore
        initialLoading={false}
        loadingMore
        messages={[message({})]}
        onLoadMore={() => undefined}
      />
    );

    expect(screen.getByRole("button", { name: "正在加载更多…" })).toBeDisabled();
  });

  it("shows every photo in a compact grid without collapsing extras", () => {
    render(
      <MessageFeed
        hasMore={false}
        initialLoading={false}
        loadingMore={false}
        messages={[message({
          media_type: "photo",
          media_items: [1, 2, 3, 4].map((n) => ({ url: `/photo-${n}`, kind: "image", role: "media" }))
        })]}
        onLoadMore={() => undefined}
      />
    );

    expect(screen.getByAltText("安全情报源中值班员发布的图片 1")).toBeInTheDocument();
    expect(screen.getByAltText("安全情报源中值班员发布的图片 4")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+1 张" })).not.toBeInTheDocument();
  });
});
