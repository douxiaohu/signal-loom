import type { Filters, MessagePage, PublicSource } from "./types";
import { useCallback, useState } from "react";
import { isMediaFilter } from "./utils";

const SAVED_FILTERS_KEY = "reader-saved-filters";
export type SavedFilter = { name: string; filters: Filters };

export function filtersFromUrl(search = window.location.search): Filters {
  const params = new URLSearchParams(search);
  const media = params.get("media") || "all";
  return { chatId: params.get("chat_id") || "all", media: isMediaFilter(media) ? media : "all", query: params.get("query") || "" };
}

export function filtersToUrl(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.chatId !== "all") params.set("chat_id", filters.chatId);
  if (filters.media !== "all") params.set("media", filters.media);
  if (filters.query.trim()) params.set("query", filters.query.trim());
  const search = params.toString();
  return search ? `/?${search}` : "/";
}

function readSaved(): SavedFilter[] {
  try { return JSON.parse(window.localStorage?.getItem(SAVED_FILTERS_KEY) || "[]") as SavedFilter[]; } catch { return []; }
}

export function useSavedFilters() {
  const [items, setItems] = useState<SavedFilter[]>(readSaved);
  const save = useCallback((name: string, filters: Filters) => {
    const next = [...items.filter((item) => item.name !== name.trim()), { name: name.trim(), filters }].filter((item) => item.name);
    try { window.localStorage?.setItem(SAVED_FILTERS_KEY, JSON.stringify(next)); } catch { /* private browsing */ } setItems(next);
  }, [items]);
  const get = useCallback((name: string) => items.find((item) => item.name === name)?.filters, [items]);
  return { items, save, get };
}


async function publicFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  return (await response.json()) as T;
}


export async function fetchPublicSources(signal?: AbortSignal) {
  const payload = await publicFetch<{ items: PublicSource[] }>("/api/public/sources", { signal });
  return payload.items;
}


export function fetchPublicMessages(
  filters: Filters,
  options: { cursor?: string; limit: number; signal?: AbortSignal }
) {
  const params = new URLSearchParams({ limit: String(options.limit), media: filters.media });
  if (options.cursor) params.set("cursor", options.cursor);
  if (filters.chatId !== "all") params.set("chat_id", filters.chatId);
  if (filters.query.trim()) params.set("query", filters.query.trim());
  return publicFetch<MessagePage>(`/api/public/messages?${params}`, { signal: options.signal });
}
