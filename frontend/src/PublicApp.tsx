import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Search, SlidersHorizontal, Sparkles } from "lucide-react";

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

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)] selection:bg-[var(--surface-muted)] transition-colors duration-200">
      {/* 极简磨砂吸顶导航栏 */}
      <header className="sticky top-0 z-30 w-full border-b border-[var(--border)] bg-[var(--card)]/80 backdrop-blur-xl transition-all">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          {/* Logo 与产品标识 */}
          <div className="flex items-center gap-3">
            <a href="/" className="flex items-center gap-2.5 group">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-cyan-500 to-blue-600 p-[1px] shadow-xs">
                <div className="w-full h-full bg-[var(--card)] rounded-[7px] flex items-center justify-center">
                  <Sparkles size={16} className="text-cyan-500 group-hover:rotate-12 transition-transform duration-300" />
                </div>
              </div>
              <div className="flex flex-col">
                <div className="flex items-center gap-1.5">
                  <h1 className="text-sm font-semibold tracking-tight text-[var(--foreground)] m-0 p-0">
                    频道资讯
                  </h1>
                  <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-[var(--surface-muted)] text-[var(--muted-foreground)]">
                    公开阅读
                  </span>
                </div>
                <span className="text-[10px] text-[var(--muted-foreground)] font-mono">
                  免密聚合浏览平台
                </span>
              </div>
            </a>
          </div>

          {/* 实时搜索框 */}
          <div className="flex-1 max-w-md hidden sm:block">
            <form onSubmit={submitSearch} className="relative">
              <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
              <input
                type="search"
                value={draftQuery}
                onChange={(e) => setDraftQuery(e.target.value)}
                placeholder="检索资讯关键词，回车确认…"
                className="w-full pl-9 pr-4 py-2 text-xs bg-[var(--surface-muted)] border border-[var(--border)] hover:border-[var(--ring)] focus:border-[var(--ring)] rounded-full text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none transition-all duration-200"
              />
            </form>
          </div>

          {/* 右侧操作区：刷新 + 主题 + 管理入口 */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleManualRefresh}
              title="手动刷新资讯"
              className="p-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)] bg-[var(--surface-muted)] hover:bg-[var(--accent)] border border-[var(--border)] rounded-lg transition-colors cursor-pointer"
            >
              <RefreshCw size={15} className={isRefreshing ? "animate-spin text-cyan-500" : ""} />
            </button>
            <ThemeSwitcher />
            <a
              href="/admin"
              className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[var(--surface-muted)] hover:bg-[var(--accent)] text-[var(--foreground)] border border-[var(--border)] transition-colors"
            >
              管理中心
            </a>
          </div>
        </div>

        {/* 移动端搜索框 */}
        <div className="sm:hidden px-4 pb-3">
          <form onSubmit={submitSearch} className="relative">
            <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
            <input
              type="search"
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              placeholder="搜索资讯…"
              className="w-full pl-9 pr-4 py-1.5 text-xs bg-[var(--surface-muted)] border border-[var(--border)] rounded-full text-[var(--foreground)] outline-none"
            />
          </form>
        </div>
      </header>

      {/* 主工作区 */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        <div className="flex flex-col lg:flex-row gap-8 items-start">
          {/* 左侧来源导航栏 */}
          <PublicSourceList
            activeChatId={filters.chatId}
            sources={sources}
            onSelect={selectSource}
          />

          {/* 右侧消息时间线内容区 */}
          <div className="flex-1 w-full min-w-0 space-y-4">
            {/* 顶部过滤药丸导航 (Pills Filter) */}
            <div className="flex items-center justify-between gap-3 pb-2 border-b border-[var(--border)]">
              <div className="flex items-center gap-1.5 overflow-x-auto py-1 scrollbar-none">
                <span className="text-xs text-[var(--muted-foreground)] flex items-center gap-1 mr-1">
                  <SlidersHorizontal size={13} />
                  <span>筛选:</span>
                </span>
                {publicMediaOptions.map((option) => {
                  const active = draftMedia === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => selectMedia(option.value)}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-all duration-150 cursor-pointer shrink-0 ${
                        active
                          ? "bg-[var(--foreground)] text-[var(--background)] shadow-xs"
                          : "bg-[var(--card)] hover:bg-[var(--surface-muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] border border-[var(--border)]"
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>

              {/* 当前状态小指标 */}
              <div className="text-xs text-[var(--muted-foreground)] font-mono shrink-0 flex items-center gap-2">
                <span>{activeSource}</span>
                <span>·</span>
                <span>{messages.length} 条</span>
                {loading && <span className="public-loading text-cyan-500 animate-pulse font-medium">正在更新…</span>}
              </div>
            </div>

            {loading && !messages.length ? (
              <span className="sr-only" role="status" aria-label={`正在加载${activeSource}消息`}>
                正在加载{activeSource}消息
              </span>
            ) : null}

            {error && (
              <div className="p-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300 text-xs flex items-center justify-between">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={handleManualRefresh}
                  className="underline font-medium hover:opacity-80 ml-2"
                >
                  重试
                </button>
              </div>
            )}

            {/* 消息卡片时间线 */}
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
    </div>
  );
}
