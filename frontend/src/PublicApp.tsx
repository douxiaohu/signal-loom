import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Search, SlidersHorizontal, Sparkles, Terminal, Zap } from "lucide-react";

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
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)] selection:bg-[var(--neon)]/20 selection:text-[var(--neon)] transition-colors duration-300">
      {/* 顶部未来科技感毛玻璃吸顶导航栏 */}
      <header className="sticky top-0 z-40 w-full border-b border-[var(--border)] bg-[var(--card)]/60 backdrop-blur-2xl transition-all shadow-[0_4px_30px_rgba(0,0,0,0.3)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          {/* Logo 与科技感标识 */}
          <div className="flex items-center gap-3">
            <a href="/" className="flex items-center gap-2.5 group">
              <div className="relative w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-400 via-blue-500 to-purple-600 p-[1.5px] shadow-[0_0_15px_rgba(0,240,255,0.3)] group-hover:shadow-[0_0_25px_rgba(0,240,255,0.6)] transition-all duration-300">
                <div className="w-full h-full bg-[#0B0E14] rounded-[10px] flex items-center justify-center">
                  <Zap size={18} className="text-[var(--neon)] group-hover:scale-110 transition-transform duration-300" />
                </div>
              </div>
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <h1 className="text-base font-bold tracking-tight text-[var(--foreground)] m-0 p-0">
                    频道资讯
                  </h1>
                  <span className="text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-[var(--neon)]/10 text-[var(--neon)] border border-[var(--neon)]/30 font-semibold shadow-[0_0_8px_rgba(0,240,255,0.2)]">
                    LIVE RADAR
                  </span>
                </div>
                <span className="text-[10px] text-[var(--muted-foreground)] font-mono">
                  Realtime News Aggregator
                </span>
              </div>
            </a>
          </div>

          {/* 实时毛玻璃霓虹搜索框 */}
          <div className="flex-1 max-w-lg hidden sm:block">
            <form onSubmit={submitSearch} className="relative group/search">
              <Search
                size={15}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] group-focus-within/search:text-[var(--neon)] transition-colors duration-200"
              />
              <input
                type="search"
                value={draftQuery}
                onChange={(e) => setDraftQuery(e.target.value)}
                placeholder="检索资讯关键词，回车确认…"
                className="w-full pl-10 pr-4 py-2 text-xs bg-[var(--surface-muted)]/60 hover:bg-[var(--surface-muted)] focus:bg-[var(--card)]/90 border border-[var(--border)] group-focus-within/search:border-[var(--neon)] rounded-full text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none transition-all duration-200 shadow-inner group-focus-within/search:shadow-[0_0_20px_rgba(0,240,255,0.25)]"
              />
              {draftQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setDraftQuery("");
                    commitFilters({ ...filters, query: "" });
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] px-1.5 py-0.5 rounded bg-[var(--border)]/50"
                >
                  清除
                </button>
              )}
            </form>
          </div>

          {/* 右侧操作区：刷新 + 主题 + 管理中心 */}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleManualRefresh}
              title="手动刷新资讯"
              className="p-2 text-[var(--muted-foreground)] hover:text-[var(--neon)] bg-[var(--surface-muted)]/80 hover:bg-[var(--card)] border border-[var(--border)] hover:border-[var(--neon)]/50 rounded-xl transition-all duration-200 cursor-pointer hover:shadow-[0_0_12px_rgba(0,240,255,0.2)] active:scale-95"
            >
              <RefreshCw size={15} className={isRefreshing ? "animate-spin text-[var(--neon)]" : ""} />
            </button>
            <ThemeSwitcher />
            <a
              href="/admin"
              className="text-xs font-semibold px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-[var(--neon)]/10 to-purple-600/10 hover:from-[var(--neon)]/20 hover:to-purple-600/20 text-[var(--foreground)] border border-[var(--border)] hover:border-[var(--neon)]/50 transition-all duration-200 shadow-2xs hover:shadow-[0_0_15px_rgba(0,240,255,0.15)] flex items-center gap-1.5"
            >
              <Terminal size={13} className="text-[var(--neon)]" />
              <span>管理中心</span>
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
              className="w-full pl-9 pr-4 py-2 text-xs bg-[var(--surface-muted)] border border-[var(--border)] focus:border-[var(--neon)] rounded-full text-[var(--foreground)] outline-none"
            />
          </form>
        </div>
      </header>

      {/* 主工作区 */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          {/* 左侧可收缩霓虹来源导航栏 */}
          <PublicSourceList
            activeChatId={filters.chatId}
            sources={sources}
            onSelect={selectSource}
          />

          {/* 右侧消息时间线内容区 */}
          <div className="flex-1 w-full min-w-0 space-y-4">
            {/* 极简霓虹过滤标签 (Minimalist Filter Tabs with Glowing Indicator) */}
            <div className="flex items-center justify-between gap-3 pb-3 border-b border-[var(--border)]">
              <div className="flex items-center gap-1 overflow-x-auto py-1 scrollbar-none">
                <span className="text-xs text-[var(--muted-foreground)] flex items-center gap-1 mr-2 shrink-0">
                  <SlidersHorizontal size={13} className="text-[var(--neon)]" />
                  <span>类型:</span>
                </span>
                <div className="flex items-center gap-1.5 p-1 bg-[var(--card)]/50 border border-[var(--border)] rounded-2xl backdrop-blur-md">
                  {publicMediaOptions.map((option) => {
                    const active = draftMedia === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => selectMedia(option.value)}
                        className={`relative px-3.5 py-1 text-xs font-medium rounded-xl transition-all duration-200 cursor-pointer shrink-0 ${
                          active
                            ? "bg-[var(--neon)] text-black font-bold shadow-[0_0_15px_rgba(0,240,255,0.4)] scale-102"
                            : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--surface-muted)]"
                        }`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 当前状态指标 */}
              <div className="text-xs text-[var(--muted-foreground)] font-mono shrink-0 flex items-center gap-2">
                <span className="text-[var(--foreground)] font-medium">{activeSource}</span>
                <span>·</span>
                <span>{messages.length} 条</span>
                {loading && (
                  <span className="public-loading text-[var(--neon)] animate-pulse font-medium flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--neon)] animate-ping" />
                    <span>正在更新…</span>
                  </span>
                )}
              </div>
            </div>

            {loading && !messages.length ? (
              <span className="sr-only" role="status" aria-label={`正在加载${activeSource}消息`}>
                正在加载{activeSource}消息
              </span>
            ) : null}

            {error && (
              <div className="p-4 rounded-2xl border border-red-500/40 bg-red-950/20 text-red-400 text-xs flex items-center justify-between shadow-[0_0_20px_rgba(239,68,68,0.15)]">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={handleManualRefresh}
                  className="underline font-semibold hover:text-red-300 ml-2"
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
