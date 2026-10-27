import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PublicHighlights, { selectHighlights } from "../src/components/PublicHighlights";
import type { Message } from "../src/types";

const message = (id: number, time: string, content: string): Message => ({
  id, chat_id: -1, chat_title: "公开频道", message_id: id, sender_name: "编辑",
  message_time: time, content, media_type: null, media_urls: [], source_url: `https://t.me/public/${id}`
});

describe("selectHighlights", () => {
  it("selects only dated public messages in the requested window", () => {
    const items = [
      message(1, "2026-09-18T10:00:00Z", "今天的公开消息"),
      message(2, "2026-09-12T10:00:00Z", "本周消息"),
      message(3, "2026-09-01T10:00:00Z", "更早消息")
    ];
    expect(selectHighlights(items, "daily", new Date("2026-09-18T12:00:00Z")).map((item) => item.id)).toEqual([1]);
    expect(selectHighlights(items, "weekly", new Date("2026-09-18T12:00:00Z")).map((item) => item.id)).toEqual([1, 2]);
  });
});

describe("PublicHighlights", () => {
  it("renders the original message, attribution, date, and source link", () => {
    render(<PublicHighlights messages={[message(1, "2026-09-18T10:00:00Z", "原始公开内容")]} period="daily" now={new Date("2026-09-18T12:00:00Z")} />);
    expect(screen.getByText("原始公开内容")).toBeInTheDocument();
    expect(screen.getByText(/编辑/)).toBeInTheDocument();
    expect(screen.getByText(/2026年9月18日/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看原消息" })).toHaveAttribute("href", "https://t.me/public/1");
  });
});
