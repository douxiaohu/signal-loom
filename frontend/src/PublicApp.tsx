import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RadioTower, RefreshCw, Search, Terminal, Zap } from "lucide-react";

import { fetchPublicMessages, fetchPublicSources } from "./public-api";
import MessageFeed from "./components/MessageFeed";
import PublicSourceList from "./components/PublicSourceList";
import { ThemeSwitcher } from "./theme";
import type { Filters, Message, MessagePage, PublicSource, MediaFilter } from "./types";
import { isMediaFilter, mediaOptions } from "./utils";

const publicMediaOptions = mediaOptions.filter((option) =>
  ["all", "photo", "video", "document"].includes(option.value)
);

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
    query: params.get("query") || "",
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const requestSequence = useRef(0);
  const pageCache = useRef(new Map<string, { page: MessagePage; storedAt: number }>());

  const loadSources = useCallback((signal?: AbortSignal) => {
    fetchPublicSources(signal)
      .then(setSources)
      .catch((caught) => {
        if (!signal?.aborted) {
          setError(caught instanceof Error ? caught.message : "来源加载失败");
        }
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadSources(controller.signal);
    return () => controller.abort();
  }, [loadSources]);

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
        if (!controller.signal.aborted && sequence === requestSequence.current) {
          setLoading(false);
          setIsRefreshing(false);
        }
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

  function submitSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    commitFilters({ ...filters, query: draftQuery.trim(), media: draftMedia });
  }

  function selectSource(chatId: string) {
    commitFilters({ ...filters, chatId });
  }

  function selectMedia(media: MediaFilter) {
    setDraftMedia(media);
    commitFilters({ ...filters, media });
  }

  function clearSearch() {
    setDraftQuery("");
    commitFilters({ ...filters, query: "" });
  }

  function handleManualRefresh() {
    setIsRefreshing(true);
    pageCache.current.clear();
    loadSources();
    commitFilters({ ...filters });
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPublicMessages(filters, { limit: PAGE_LIMIT, cursor: nextCursor });
      setMessages((current) => [
        ...current,
        ...page.items.filter((item) => !current.some((existing) => existing.id === item.id)),
      ]);
      setHasMore(page.has_more);
      setNextCursor(page.next_cursor || "");
    } finally {
      setLoadingMore(false);
    }
  }

  const activeSource =
    filters.chatId === "all"
      ? "全部公开来源"
      : sources.find((source) => String(source.chat_id) === filters.chatId)?.name || "当前来源";

  const searchField = (variant: "desktop" | "mobile") => (
    <form
      onSubmit={submitSearch}
      role="search"
      className={`pub-search ${variant === "desktop" ? "pub-header-search-desktop" : ""}`}
    >
      <Search size={15} aria-hidden="true" />
      <label className="sr-only" htmlFor={`pub-query-${variant}`}>
        {variant === "desktop" ? "检索资讯关键词" : "搜索消息关键词"}
      </label>
      <input
        id={`pub-query-${variant}`}
        type="search"
        value={draftQuery}
        onChange={(e) => setDraftQuery(e.target.value)}
        placeholder="搜索关键词，回车确认"
        className="pub-search-input"
        autoComplete="off"
      />
      {draftQuery ? (
        <button type="button" className="pub-search-clear" onClick={clearSearch} aria-label="清除搜索关键词">
          清除
        </button>
      ) : (
        <kbd className="pub-search-key" aria-hidden="true">↵</kbd>
      )}
      <button
        type="submit"
        className="pub-search-submit"
        aria-label={variant === "desktop" ? "搜索" : "搜索（移动端）"}
      >
        搜索
      </button>
    </form>
  );

  return (
    <div className="public-page">
      <a className="skip-link" href="#message-list">跳到消息列表</a>
      <header className="pub-header">
        <div className="pub-header-inner">
          <a className="pub-brand" href="/" aria-label="频道资讯首页">
            <span className="pub-brand-mark" aria-hidden="true">
              <Zap size={18} strokeWidth={2.4} />
            </span>
            <span className="pub-brand-copy">
              <h1 className="pub-brand-name">频道资讯</h1>
              <span className="pub-brand-badge">TELEGRAM</span>
            </span>
          </a>

          {searchField("desktop")}

          <div className="pub-header-actions">
            <button
              type="button"
              onClick={handleManualRefresh}
              title="刷新资讯"
              aria-label="刷新资讯"
              className={`pub-icon-button ${isRefreshing ? "is-busy" : ""}`}
            >
              <RefreshCw aria-hidden="true" />
            </button>
            <ThemeSwitcher />
            <a href="/admin" className="pub-header-link">
              <Terminal aria-hidden="true" />
              <span>管理中心</span>
            </a>
          </div>
        </div>
        <div className="pub-header-search-row">{searchField("mobile")}</div>
      </header>

      <div className="pub-layout">
        <PublicSourceList activeChatId={filters.chatId} sources={sources} onSelect={selectSource} />

        <div className="pub-main">
          <div className="pub-toolbar">
            <div className="pub-segmented" role="group" aria-label="媒体类型">
              {publicMediaOptions.map((option) => {
                const active = draftMedia === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => selectMedia(option.value)}
                    aria-pressed={active}
                    className="pub-segment"
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>

            <div className="pub-toolbar-meta">
              <RadioTower size={14} aria-hidden="true" />
              <span className="pub-toolbar-source" title={activeSource}>{activeSource}</span>
              <span className="pub-toolbar-dot" aria-hidden="true">·</span>
              <span>{messages.length} 条</span>
              {loading && (
                <span className="public-loading pub-live">正在更新…</span>
              )}
            </div>
          </div>

          {loading && !messages.length ? (
            <span className="sr-only" role="status" aria-label={`正在加载${activeSource}消息`}>
              正在加载{activeSource}消息
            </span>
          ) : null}

          {error && (
            <div className="pub-notice" role="alert">
              <span>{error}</span>
              <button type="button" onClick={handleManualRefresh}>重试</button>
            </div>
          )}

          <MessageFeed
            messages={messages}
            hasMore={hasMore}
            initialLoading={loading}
            loadingMore={loadingMore}
            onLoadMore={() => void loadMore()}
            groupDuplicates
          />
        </div>
      </div>
    </div>
  );
}
