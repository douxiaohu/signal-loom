import { itemsOf, request } from "./lib/http";
import { messagePageParams } from "./lib/filters";
import type { Filters, MessagePage, PublicSource } from "./types";

export async function fetchPublicSources(signal?: AbortSignal) {
  return itemsOf(await request<{ items?: PublicSource[] | null }>("/api/public/sources", { signal }));
}

export async function fetchPublicMessages(
  filters: Filters,
  options: { cursor?: string; limit: number; signal?: AbortSignal }
): Promise<MessagePage> {
  const params = messagePageParams(filters, options);
  const page = await request<MessagePage>(`/api/public/messages?${params}`, { signal: options.signal });
  return { ...page, items: page.items ?? [] };
}
