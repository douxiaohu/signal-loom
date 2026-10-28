import { render } from "@testing-library/react";
import { vi } from "vitest";

import MessageFeed from "../src/components/MessageFeed";
import type { Message } from "../src/types";

const rendered = vi.hoisted(() => ({ bodies: [] as string[] }));

// Counts how often a card's body is drawn; the real component does the same work for each render.
vi.mock("../src/components/RichContent", () => ({
  default: ({ content }: { content: string }) => {
    rendered.bodies.push(content);
    return <p>{content}</p>;
  }
}));

function message(id: number, content: string): Message {
  return {
    id,
    chat_id: -1001,
    chat_title: "来源",
    message_id: id,
    sender_name: "编辑",
    message_time: "2026-07-13T08:00:00+00:00",
    content,
    media_type: null,
    media_urls: [],
    media_items: [],
    source_url: ""
  };
}

describe("MessageFeed rendering cost", () => {
  beforeEach(() => {
    rendered.bodies.length = 0;
  });

  it("does not redraw the cards when only the loading flags around them change", () => {
    const messages = [message(2, "第二条"), message(1, "第一条")];
    const props = { hasMore: true, initialLoading: false, messages, onLoadMore: () => undefined };
    const { rerender } = render(<MessageFeed {...props} loadingMore={false} />);
    expect(rendered.bodies).toHaveLength(2);

    rerender(<MessageFeed {...props} loadingMore />);
    rerender(<MessageFeed {...props} onLoadMore={() => undefined} loadingMore={false} />);

    expect(rendered.bodies).toHaveLength(2);
  });

  it("draws only the new card when a message is added", () => {
    const first = message(1, "第一条");
    const props = { hasMore: false, initialLoading: false, loadingMore: false, onLoadMore: () => undefined };
    const { rerender } = render(<MessageFeed {...props} messages={[first]} />);

    rerender(<MessageFeed {...props} messages={[message(2, "新来的"), first]} />);

    expect(rendered.bodies).toEqual(["第一条", "新来的"]);
  });
});
