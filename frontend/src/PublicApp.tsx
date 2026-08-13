import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchPublicMessages, fetchPublicSources } from "./public-api";
import MessageFeed from "./components/MessageFeed";
import PublicHeader from "./components/PublicHeader";
import PublicSourceList from "./components/PublicSourceList";
import type { Filters, Message, MessagePage, PublicSource } from "./types";
import { isMediaFilter, mediaOptions } from "./utils";


const PAGE_LIMIT = 20;
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 20;


function filterKey(filters: Filters) {
  return `${filters.chatId}|${filters.media}|${filters.query.trim()}`;
}


function filtersFromUrl(): Filters {
  const params = new URLSearchParams(window.location.search);
  const media = params.get("media") || "all";
  return {
    chatId: params.get("chat_id") || "all",
    media: isMediaFilter(media) ? media : "all",
    query: params.get("query") || ""
  };
}


function filtersToUrl(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.chatId !== "all") params.set("chat_id", filters.chatId);
  if (filters.media !== "all") params.set("media", filters.media);
  if (filters.query) params.set("query", filters.query);
  const search = params.toString();
  return search ? `/?${search}` : "/";
}


export default function PublicApp() {
  const initial = useMemo(filtersFromUrl, []);
  const [sources, setSources] = useState<PublicSource[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [filters, setFilters] = useState<Filters>(initial);
  const [draftQuery, setDraftQuery] = useState(initial.query);
  const [draftMedia, setDraftMedia] = useState(initial.media);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const requestSequence = useRef(0);
  const pageCache = useRef(new Map<string, { page: MessagePage; storedAt: number }>());

  useEffect(() => {
    const controller = new AbortController();
    fetchPublicSources(controller.signal)
      .then(setSources)
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "来源加载失败");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    const key = filterKey(filters);
    const cached = pageCache.current.get(key);
    if (cached && Date.now() - cached.storedAt < CACHE_TTL_MS) {
      setMessages(cached.page.items);
      setHasMore(cached.page.has_more);
      setNextCursor(cached.page.next_cursor || "");
    } else {
      if (cached) pageCache.current.delete(key);
      setMessages([]);
      setHasMore(false);
      setNextCursor("");
    }
    setLoading(true);
    setError("");
    fetchPublicMessages(filters, { limit: PAGE_LIMIT, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setMessages(page.items);
        setHasMore(page.has_more);
        setNextCursor(page.next_cursor || "");
        pageCache.current.delete(key);
        pageCache.current.set(key, { page, storedAt: Date.now() });
        while (pageCache.current.size > CACHE_LIMIT) {
          const oldestKey = pageCache.current.keys().next().value as string | undefined;
          if (!oldestKey) break;
          pageCache.current.delete(oldestKey);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted && sequence === requestSequence.current) {
          setError(caught instanceof Error ? caught.message : "消息加载失败");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && sequence === requestSequence.current) setLoading(false);
      });
    return () => controller.abort();
  }, [filters]);

  useEffect(() => {
    function restoreFilters() {
      const next = filtersFromUrl();
      setFilters(next);
      setDraftQuery(next.query);
      setDraftMedia(next.media);
    }
    window.addEventListener("popstate", restoreFilters);
    return () => window.removeEventListener("popstate", restoreFilters);
  }, []);

  const commitFilters = useCallback((next: Filters) => {
    const url = filtersToUrl(next);
    if (`${window.location.pathname}${window.location.search}` !== url) {
      window.history.pushState(null, "", url);
    }
    setFilters(next);
  }, []);

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    commitFilters({ ...filters, query: draftQuery.trim(), media: draftMedia });
  }

  function selectSource(chatId: string) {
    commitFilters({ ...filters, chatId });
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPublicMessages(filters, { limit: PAGE_LIMIT, cursor: nextCursor });
      setMessages((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setHasMore(page.has_more);
      setNextCursor(page.next_cursor || "");
    } finally {
      setLoadingMore(false);
    }
  }

  const activeSource = filters.chatId === "all"
    ? "全部公开来源"
    : sources.find((source) => String(source.chat_id) === filters.chatId)?.name || "当前来源";

  return (
    <div className="public-shell">
      <a className="skip-link" href="#message-list">跳到消息列表</a>
      <PublicHeader onSubmit={submitSearch} query={draftQuery} onQueryChange={setDraftQuery} />
      <div className="public-filter-row">
        <label htmlFor="public-media">媒体类型</label>
        <select id="public-media" value={draftMedia} onChange={(event) => setDraftMedia(event.target.value as Filters["media"])}>
          {mediaOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <div className="public-layout">
        <PublicSourceList activeChatId={filters.chatId} sources={sources} onSelect={selectSource} />
        <section className="public-timeline" aria-busy={loading}>
          <header className="public-timeline-heading">
            <div><h2>{activeSource}</h2><p>{filters.query ? `关键词：“${filters.query}”` : "按时间倒序浏览公开消息"}</p></div>
            {loading ? <span className="public-loading">正在更新…</span> : null}
          </header>
          {loading && !messages.length ? (
            <span className="sr-only" role="status" aria-label={`正在加载${activeSource}消息`}>
              正在加载{activeSource}消息
            </span>
          ) : null}
          {error ? <div className="inline-error"><strong>加载失败</strong><span>{error}</span></div> : null}
          <MessageFeed
            messages={messages}
            hasMore={hasMore}
            initialLoading={loading}
            loadingMore={loadingMore}
            onLoadMore={() => void loadMore()}
          />
        </section>
      </div>
    </div>
  );
}
