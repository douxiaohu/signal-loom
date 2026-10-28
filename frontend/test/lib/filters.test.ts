import type { Filters, Message } from "../../src/types";
import { dedupeMessages, filterKey, filtersToParams, messagePageParams, parseFilters, withSearch } from "../../src/lib/filters";

const DEFAULT_FILTERS: Filters = { chatId: "all", media: "all", query: "" };

const filters: Filters = { chatId: "42", media: "photo", query: "安全 漏洞" };

function message(id: number, content = `m${id}`): Message {
  return {
    id, chat_id: -1, chat_title: "t", message_id: id, sender_name: "s", message_time: "2026-07-13T08:00:00+00:00",
    content, media_type: null, media_urls: [], source_url: ""
  };
}

describe("filters and URLs", () => {
  it("round trips through a shareable URL and omits defaults", () => {
    const url = withSearch("/", filtersToParams(filters));
    expect(url).toBe("/?chat_id=42&media=photo&query=%E5%AE%89%E5%85%A8+%E6%BC%8F%E6%B4%9E");
    expect(parseFilters(new URL(url, "https://example.test").search)).toEqual(filters);
    expect(withSearch("/", filtersToParams(DEFAULT_FILTERS))).toBe("/");
  });

  it("puts leading parameters (the admin view) first and skips empty ones", () => {
    expect(withSearch("/admin", filtersToParams(filters, { view: "messages" }))).toBe(
      "/admin?view=messages&chat_id=42&media=photo&query=%E5%AE%89%E5%85%A8+%E6%BC%8F%E6%B4%9E"
    );
    expect(withSearch("/admin", filtersToParams(DEFAULT_FILTERS, { view: null }))).toBe("/admin");
  });

  it("falls back to defaults for missing or unknown values", () => {
    expect(parseFilters("")).toEqual(DEFAULT_FILTERS);
    expect(parseFilters("?media=exe&chat_id=&query=")).toEqual(DEFAULT_FILTERS);
    expect(parseFilters("?media=document").media).toBe("document");
  });

  it("treats queries that differ only by outer whitespace as the same list", () => {
    expect(filterKey({ ...filters, query: "  漏洞 " })).toBe(filterKey({ ...filters, query: "漏洞" }));
    expect(filterKey(filters)).not.toBe(filterKey({ ...filters, chatId: "43" }));
    expect(filterKey(filters)).not.toBe(filterKey({ ...filters, media: "video" }));
  });

  it("cannot confuse two different filter sets through the separator", () => {
    expect(filterKey({ chatId: "a", media: "all", query: "b" })).not.toBe(filterKey({ chatId: "a\u0000all", media: "all", query: "" }));
  });
});

describe("messagePageParams", () => {
  it("sends only what the API needs", () => {
    expect(messagePageParams(DEFAULT_FILTERS, { limit: 20 }).toString()).toBe("limit=20&media=all");
    expect(messagePageParams({ ...filters, query: "  漏洞  " }, { limit: 30, cursor: "abc" }).toString()).toBe(
      "limit=30&media=photo&cursor=abc&chat_id=42&query=%E6%BC%8F%E6%B4%9E"
    );
  });
});

describe("dedupeMessages", () => {
  it("keeps one entry per id at its first position with the latest data", () => {
    const merged = dedupeMessages([message(1, "old"), message(2), message(1, "new")]);
    expect(merged.map((item) => item.id)).toEqual([1, 2]);
    expect(merged[0].content).toBe("new");
  });
});
