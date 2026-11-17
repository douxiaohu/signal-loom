import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Flower2, RadioTower, RefreshCw, Search } from "lucide-react";

import { fetchPublicMessages, fetchPublicSources } from "./public-api";
import MessageFeed from "./components/MessageFeed";
import ChannelPulse from "./components/ChannelPulse";
import PublicSourceList from "./components/PublicSourceList";
import { useMessageFeed, type FeedFetcher } from "./hooks/useMessageFeed";
import { useUrlFilters } from "./hooks/useUrlFilters";
import { ApiError } from "./lib/http";
import { filtersToParams, parseFilters, withSearch } from "./lib/filters";
import { ReadingLightSwitch } from "./theme";
import AssemblyIntro from "./components/editorial/AssemblyIntro";
import LandscapeFooter from "./components/editorial/LandscapeFooter";
import type { Filters, MediaFilter, PublicSource } from "./types";
import { mediaOptions } from "./utils";

const publicMediaOptions = mediaOptions.filter((option) =>
  ["all", "photo", "video", "document"].includes(option.value)
);

const PAGE_LIMIT = 20;
const FEED_CACHE = { ttlMs: 60_000, limit: 20 };

const filtersFromUrl = () => parseFilters(window.location.search);
const filtersToUrl = (filters: Filters) => withSearch("/", filtersToParams(filters));

const fetchPage: FeedFetcher = ({ filters, cursor, signal }) =>
  fetchPublicMessages(filters, { limit: PAGE_LIMIT, cursor, signal });

const feedErrorText = (caught: unknown) => (caught instanceof Error ? caught.message : "消息加载失败");

export default function PublicApp() {
  const initial = useMemo(filtersFromUrl, []);
  const [sources, setSources] = useState<PublicSource[]>([]);
  const [sourcesError, setSourcesError] = useState("");
  const [sourcesToken, setSourcesToken] = useState(0);
  const [fallbackNotice, setFallbackNotice] = useState("");
  const [draftQuery, setDraftQuery] = useState(initial.query);
  const [draftMedia, setDraftMedia] = useState(initial.media);

  const { filters, commit } = useUrlFilters({
    read: filtersFromUrl,
    toUrl: filtersToUrl,
    onRestore: (next) => {
      setDraftQuery(next.query);
      setDraftMedia(next.media);
      setFallbackNotice("");
    }
  });

  const feed = useMessageFeed({
    filters,
    fetchPage,
    cache: FEED_CACHE,
    formatError: feedErrorText,
    onError: (caught) => {
      // A bookmarked source that no longer exists (or was made private) answers 404 forever.
      if (caught instanceof ApiError && caught.status === 404 && filters.chatId !== "all") {
        setFallbackNotice("所选来源不存在或未公开，已切换到全部公开来源");
        commit({ ...filters, chatId: "all" }, { replace: true });
      }
    }
  });

  useEffect(() => {
    const controller = new AbortController();
    fetchPublicSources(controller.signal)
      .then((items) => {
        setSources(items);
        setSourcesError("");
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setSourcesError(caught instanceof Error ? caught.message : "来源加载失败");
        }
      });
    return () => controller.abort();
  }, [sourcesToken]);

  /** Shows `next`; asking again for the list that is already shown just refreshes it. */
  function apply(next: Filters) {
    setFallbackNotice("");
    if (!commit(next)) feed.revalidate();
  }

  function submitSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    apply({ ...filters, query: draftQuery.trim(), media: draftMedia });
  }

  function selectSource(chatId: string) {
    apply({ ...filters, chatId });
  }

  function selectMedia(media: MediaFilter) {
    setDraftMedia(media);
    apply({ ...filters, media });
  }

  function clearSearch() {
    setDraftQuery("");
    apply({ ...filters, query: "" });
  }

  function handleManualRefresh() {
    setFallbackNotice("");
    setSourcesToken((value) => value + 1);
    feed.reload();
  }

  const notice = fallbackNotice || feed.error || sourcesError;

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
          <a className="pub-brand" href="/" aria-label="拾讯首页">
            <span className="pub-brand-mark" aria-hidden="true">
              <Flower2 size={27} strokeWidth={1.25} />
            </span>
            <span className="pub-brand-copy">
              <h1 className="pub-brand-name">拾讯</h1>
              <span className="pub-brand-badge">signal loom</span>
            </span>
          </a>

          <nav className="pub-header-nav" aria-label="主导航"><a href="#reading">资讯</a><a href="#sources">来源</a><a href="#about">关于</a></nav>

          <div className="pub-header-actions">
            <button
              type="button"
              onClick={handleManualRefresh}
              title="刷新资讯"
              aria-label="刷新资讯"
              className={`pub-icon-button ${feed.refreshing ? "is-busy" : ""}`}
            >
              <RefreshCw aria-hidden="true" />
            </button>
            <ReadingLightSwitch />
            <a href="/admin" className="pub-header-link">
              <span>管理中心</span>
              <ArrowUpRight aria-hidden="true" />
            </a>
          </div>
        </div>
      </header>

      <div className="editorial-wrap"><AssemblyIntro /></div>

      <section className="reading-section editorial-wrap" id="reading" aria-label="拾讯阅读区">
      <div className="reading-head"><div><span className="reading-kicker">THE READING ROOM</span><h2>此刻，值得一读<span>每一个声音，都有来处。</span></h2></div>{searchField("desktop")}</div>
      <div className="pub-header-search-row">{searchField("mobile")}</div>
      <ChannelPulse sources={sources} messages={feed.messages} loading={feed.loading} />
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
              <span>{feed.messages.length} 条</span>
              {feed.loading && (
                <span className="public-loading pub-live">正在更新…</span>
              )}
            </div>
          </div>

          {feed.loading && !feed.messages.length ? (
            <span className="sr-only" role="status" aria-label={`正在加载${activeSource}消息`}>
              正在加载{activeSource}消息
            </span>
          ) : null}

          {notice && (
            <div className="pub-notice" role="alert">
              <span>{notice}</span>
              {fallbackNotice ? (
                <button type="button" onClick={() => setFallbackNotice("")}>知道了</button>
              ) : (
                <button type="button" onClick={handleManualRefresh}>重试</button>
              )}
            </div>
          )}

          <MessageFeed
            messages={feed.messages}
            hasMore={feed.hasMore}
            initialLoading={feed.loading}
            loadingMore={feed.loadingMore}
            onLoadMore={() => void feed.loadMore()}
            groupDuplicates
          />
        </div>
      </div>
      </section>
      <LandscapeFooter />
    </div>
  );
}
