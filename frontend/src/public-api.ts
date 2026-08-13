import type { Filters, MessagePage, PublicSource } from "./types";


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
