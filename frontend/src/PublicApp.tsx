import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Bookmark,
  Flower2,
  RadioTower,
  RefreshCw,
  Search,
} from "lucide-react";

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
import { LanguageSelect, useI18n, translate } from "./i18n";
import { useSite } from "./site";
import { useReadingPosition } from "./hooks/useReadingPosition";
import type { Filters, MediaFilter, PublicSource } from "./types";
import { mediaOptions } from "./utils";

const publicMediaOptions = mediaOptions.filter((option) =>
  ["all", "photo", "video", "document"].includes(option.value),
);

const PAGE_LIMIT = 20;
const FEED_CACHE = { ttlMs: 60_000, limit: 20 };

const filtersFromUrl = () => parseFilters(window.location.search);
const filtersToUrl = (filters: Filters) =>
  withSearch("/", filtersToParams(filters));

const fetchPage: FeedFetcher = ({ filters, cursor, signal }) =>
  fetchPublicMessages(filters, { limit: PAGE_LIMIT, cursor, signal });

const feedErrorText = (caught: unknown) =>
  caught instanceof Error ? caught.message : translate("消息加载失败");

export default function PublicApp() {
  const { t } = useI18n();
  const site = useSite();
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
    },
  });

  const feed = useMessageFeed({
    filters,
    fetchPage,
    cache: FEED_CACHE,
    formatError: feedErrorText,
    onError: (caught) => {
      // A bookmarked source that no longer exists (or was made private) answers 404 forever.
      if (
        caught instanceof ApiError &&
        caught.status === 404 &&
        filters.chatId !== "all"
      ) {
        setFallbackNotice(t("所选来源不存在或未公开，已切换到全部公开来源"));
        commit({ ...filters, chatId: "all" }, { replace: true });
      }
    },
  });

  const readingPosition = useReadingPosition(
    feed.messages,
    feed.loading || feed.loadingMore,
    feed.hasMore,
    feed.loadMore,
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchPublicSources(controller.signal)
      .then((items) => {
        setSources(items);
        setSourcesError("");
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setSourcesError(
            caught instanceof Error ? caught.message : t("来源加载失败"),
          );
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
      ? t("全部公开来源")
      : sources.find((source) => String(source.chat_id) === filters.chatId)
          ?.name || t("当前来源");

  const searchField = (variant: "desktop" | "mobile") => (
    <form
      onSubmit={submitSearch}
      role="search"
      className={`pub-search ${variant === "desktop" ? "pub-header-search-desktop" : ""}`}
    >
      <Search size={15} aria-hidden="true" />
      <label className="sr-only" htmlFor={`pub-query-${variant}`}>
        {variant === "desktop" ? t("检索资讯关键词") : t("搜索消息关键词")}
      </label>
      <input
        id={`pub-query-${variant}`}
        type="search"
        value={draftQuery}
        onChange={(e) => setDraftQuery(e.target.value)}
        placeholder={t("搜索关键词，回车确认")}
        className="pub-search-input"
        autoComplete="off"
      />
      {draftQuery ? (
        <button
          type="button"
          className="pub-search-clear"
          onClick={clearSearch}
          aria-label={t("清除搜索关键词")}
        >
          {t("清除")}
        </button>
      ) : (
        <kbd className="pub-search-key" aria-hidden="true">
          ↵
        </kbd>
      )}
      <button
        type="submit"
        className="pub-search-submit"
        aria-label={variant === "desktop" ? t("搜索") : t("搜索（移动端）")}
      >
        {t("搜索")}
      </button>
    </form>
  );

  return (
    <div className="public-page">
      <a className="skip-link" href="#message-list">
        {t("跳到消息列表")}
      </a>
      <header className="pub-header">
        <div className="pub-header-inner">
          <a className="pub-brand" href="/" aria-label={t("拾讯首页")}>
            <span className="pub-brand-mark" aria-hidden="true">
              <Flower2 size={27} strokeWidth={1.25} />
            </span>
            <span className="pub-brand-copy">
              <h1 className="pub-brand-name">{site.name}</h1>
              <span className="pub-brand-badge">signal loom</span>
            </span>
          </a>

          <nav className="pub-header-nav" aria-label={t("主导航")}>
            <a href="#reading">{t("资讯")}</a>
            <a href="#sources">{t("来源")}</a>
            <a href="#about">{t("关于")}</a>
          </nav>

          <div className="pub-header-actions">
            <button
              type="button"
              onClick={handleManualRefresh}
              title={t("刷新资讯")}
              aria-label={t("刷新资讯")}
              className={`pub-icon-button ${feed.refreshing ? "is-busy" : ""}`}
            >
              <RefreshCw aria-hidden="true" />
            </button>
            <a
              className="reader-saved-link"
              href="/saved"
              aria-label={t("收藏")}
              title={t("收藏")}
            >
              <Bookmark size={16} />
            </a>
            <LanguageSelect />
            <ReadingLightSwitch />
            <a href="/admin" className="pub-header-link">
              <span>{t("管理中心")}</span>
              <ArrowUpRight aria-hidden="true" />
            </a>
          </div>
        </div>
      </header>

      <div className="editorial-wrap">
        <AssemblyIntro />
      </div>

      <section
        className="reading-section editorial-wrap"
        id="reading"
        aria-label={t("拾讯阅读区")}
      >
        <div className="reading-head">
          <div>
            <span className="reading-kicker">THE READING ROOM</span>
            <h2>
              {t("此刻，值得一读")}
              <span>{t("每一个声音，都有来处。")}</span>
            </h2>
          </div>
          {searchField("desktop")}
        </div>
        <div className="pub-header-search-row">{searchField("mobile")}</div>
        {readingPosition.position && (
          <div className="reader-resume">
            <a href={readingPosition.href}>{t("继续上次阅读")}</a>
            <button onClick={readingPosition.forget}>
              {t("忘记阅读位置")}
            </button>
          </div>
        )}
        <ChannelPulse
          sources={sources}
          messages={feed.messages}
          loading={feed.loading}
        />
        <div className="pub-layout">
          <PublicSourceList
            activeChatId={filters.chatId}
            sources={sources}
            onSelect={selectSource}
          />

          <div className="pub-main">
            <div className="pub-toolbar">
              <div
                className="pub-segmented"
                role="group"
                aria-label={t("媒体类型")}
              >
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
                      {t(option.label)}
                    </button>
                  );
                })}
              </div>

              <div className="pub-toolbar-meta">
                <RadioTower size={14} aria-hidden="true" />
                <span className="pub-toolbar-source" title={activeSource}>
                  {activeSource}
                </span>
                <span className="pub-toolbar-dot" aria-hidden="true">
                  ·
                </span>
                <span>{t("{n} 条", { n: feed.messages.length })}</span>
                {feed.loading && (
                  <span className="public-loading pub-live">
                    {t("正在更新…")}
                  </span>
                )}
              </div>
            </div>

            {feed.loading && !feed.messages.length ? (
              <span
                className="sr-only"
                role="status"
                aria-label={t("正在加载{source}消息", { source: activeSource })}
              >
                {t("正在加载{source}消息", { source: activeSource })}
              </span>
            ) : null}

            {notice && (
              <div className="pub-notice" role="alert">
                <span>{notice}</span>
                {fallbackNotice ? (
                  <button type="button" onClick={() => setFallbackNotice("")}>
                    {t("知道了")}
                  </button>
                ) : (
                  <button type="button" onClick={handleManualRefresh}>
                    {t("重试")}
                  </button>
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
