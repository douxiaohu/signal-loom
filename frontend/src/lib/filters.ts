import type { Filters, Message } from "../types";
import { isMediaFilter } from "../utils";

export const DEFAULT_FILTERS: Filters = { chatId: "all", media: "all", query: "" };

/** Reads the filters out of a query string such as window.location.search. */
export function parseFilters(search: string): Filters {
  const params = new URLSearchParams(search);
  const media = params.get("media") || "all";
  return {
    chatId: params.get("chat_id") || "all",
    media: isMediaFilter(media) ? media : "all",
    query: params.get("query") || ""
  };
}

/** Two filter sets with the same key load the same list. */
export function filterKey(filters: Filters): string {
  return `${filters.chatId}\u0000${filters.media}\u0000${filters.query.trim()}`;
}

/**
 * Browser-URL parameters for a filter set. `leading` params (the admin's
 * ?view=...) come first, then only the filters that differ from the default.
 */
export function filtersToParams(filters: Filters, leading: Record<string, string | null> = {}): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(leading)) {
    if (value) params.set(name, value);
  }
  if (filters.chatId !== "all") params.set("chat_id", filters.chatId);
  if (filters.media !== "all") params.set("media", filters.media);
  if (filters.query) params.set("query", filters.query);
  return params;
}

export function withSearch(pathname: string, params: URLSearchParams): string {
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}

/** Query parameters of the message-list endpoints. */
export function messagePageParams(filters: Filters, options: { cursor?: string; limit: number }): URLSearchParams {
  const params = new URLSearchParams({ limit: String(options.limit), media: filters.media });
  if (options.cursor) params.set("cursor", options.cursor);
  if (filters.chatId !== "all") params.set("chat_id", filters.chatId);
  if (filters.query.trim()) params.set("query", filters.query.trim());
  return params;
}

/** Keeps one entry per message id (the first position, the latest data). */
export function dedupeMessages(items: Message[]): Message[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
