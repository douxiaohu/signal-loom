import { vi } from "vitest";

import type { Message, MessagePage } from "../../src/types";

export function message(id: number, content = `message ${id}`): Message {
  return {
    id,
    chat_id: -1001,
    chat_title: "来源",
    message_id: id,
    sender_name: "编辑",
    message_time: `2026-07-13T08:${String(id % 60).padStart(2, "0")}:00+00:00`,
    content,
    media_type: null,
    media_urls: [],
    media_items: [],
    source_url: ""
  };
}

export function page(ids: number[], hasMore = false, nextCursor: string | null = null): MessagePage {
  return { items: ids.map((id) => message(id)), has_more: hasMore, next_cursor: nextCursor, total: null };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function abortError() {
  return new DOMException("aborted", "AbortError");
}

/** Rejects with an AbortError as soon as the signal fires, like fetch does. */
export function abortable<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
    work.then(resolve, reject);
  });
}

export function json(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }));
}

/** Replaces fetch with a route function; returning undefined means "no such route". */
export function stubFetch(route: (url: URL, init?: RequestInit) => Promise<Response> | undefined) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    const response = route(url, init);
    if (!response) throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function callsTo(fetchMock: ReturnType<typeof stubFetch>, pathname: string) {
  return fetchMock.mock.calls.filter(([input]) => new URL(String(input), window.location.origin).pathname === pathname).length;
}

export function source(chatId: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    chat_id: chatId,
    name,
    source_url: `https://t.me/s${Math.abs(chatId)}`,
    source_type: "public",
    enabled: true,
    public_visible: true,
    message_count: 1,
    last_message_time: null,
    health_status: "healthy",
    last_run_at: null,
    last_success_at: null,
    last_error: null,
    fetched_count: 0,
    saved_count: 0,
    ...extra
  };
}

export const EMPTY_STATS = { total: 0, unique_ips: 0, today: 0, today_unique: 0, last_24h: 0, last_7d_unique: 0 };
