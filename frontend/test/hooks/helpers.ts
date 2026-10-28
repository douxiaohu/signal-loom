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
