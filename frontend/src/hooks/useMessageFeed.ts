import { useCallback, useEffect, useRef, useState } from "react";

import { dedupeMessages, filterKey } from "../lib/filters";
import type { Filters, Message, MessagePage } from "../types";
import { errorMessage } from "../utils";
import { useLatest } from "./useLatest";

export type FeedFetcher = (args: { filters: Filters; cursor?: string; signal: AbortSignal }) => Promise<MessagePage>;

export type FeedCacheOptions = {
  /** How long a first page may be shown instantly while it is re-fetched. */
  ttlMs: number;
  /** How many filter sets are remembered (oldest dropped first). */
  limit: number;
};

export type UseMessageFeedOptions = {
  filters: Filters;
  fetchPage: FeedFetcher;
  /** Nothing is fetched (and the list is emptied) while this is false. */
  enabled?: boolean;
  /** Keep showing the old list until the first page of the new filters arrives. */
  keepPrevious?: boolean;
  cache?: FeedCacheOptions;
  /** Turns a failure into the text stored in `error`. */
  formatError?: (caught: unknown) => string;
  /** Sees every failure that is not a cancellation (for example to log out on 401). */
  onError?: (caught: unknown) => void;
};

export type MessageFeed = {
  messages: Message[];
  hasMore: boolean;
  /** The first page is being fetched (also while a cached page is revalidated). */
  loading: boolean;
  loadingMore: boolean;
  /** True from reload() until the page it asked for has arrived. */
  refreshing: boolean;
  error: string;
  lastLoadedAt: Date | null;
  /** Changes whenever a fresh first page starts loading. */
  generation: number;
  loadMore: () => Promise<void>;
  /** Forgets cached pages and fetches the first page again. */
  reload: () => void;
  /** Fetches the first page again but keeps showing what is cached meanwhile. */
  revalidate: () => void;
  /** Puts messages at the top (used to reveal "new messages"). */
  prepend: (items: Message[]) => void;
};

type CacheEntry = { page: MessagePage; storedAt: number };

/**
 * A cursor-paginated message list for one set of filters.
 *
 * Every load belongs to an "epoch". Anything that was started for an earlier
 * epoch (a slow first page, a "load more" that was in flight when the filters
 * changed) is cancelled and, should its response arrive anyway, dropped. That is
 * what keeps a late answer for the old filters from landing in the new list.
 */
export function useMessageFeed(options: UseMessageFeedOptions): MessageFeed {
  const { enabled = true, keepPrevious = false } = options;
  const latest = useLatest(options);
  const key = filterKey(options.filters);

  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [generation, setGeneration] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  const epoch = useRef(0);
  const nextCursor = useRef("");
  const activeFilters = useRef<Filters>(options.filters);
  const moreController = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);
  const cache = useRef(new Map<string, CacheEntry>());

  useEffect(() => {
    if (!enabled) {
      epoch.current += 1;
      moreController.current?.abort();
      loadingMoreRef.current = false;
      nextCursor.current = "";
      setMessages((current) => (current.length ? [] : current));
      setHasMore(false);
      setLoading(false);
      setLoadingMore(false);
      setRefreshing(false);
      setError("");
      return;
    }

    const mine = ++epoch.current;
    const controller = new AbortController();
    const filters = latest.current.filters;
    const cacheOptions = latest.current.cache;
    activeFilters.current = filters;
    moreController.current?.abort();
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setGeneration((value) => value + 1);
    setError("");
    setLoading(true);

    const show = (page: MessagePage) => {
      setMessages(dedupeMessages(page.items));
      setHasMore(page.has_more);
      nextCursor.current = page.next_cursor || "";
    };

    const entry = cacheOptions ? cache.current.get(key) : undefined;
    if (cacheOptions && entry && Date.now() - entry.storedAt < cacheOptions.ttlMs) {
      show(entry.page);
    } else {
      if (entry) cache.current.delete(key);
      if (!keepPrevious) {
        setMessages((current) => (current.length ? [] : current));
        setHasMore(false);
        nextCursor.current = "";
      }
    }

    latest.current
      .fetchPage({ filters, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted || mine !== epoch.current) return;
        show(page);
        setLastLoadedAt(new Date());
        if (cacheOptions) {
          cache.current.delete(key);
          cache.current.set(key, { page, storedAt: Date.now() });
          while (cache.current.size > cacheOptions.limit) {
            const oldest = cache.current.keys().next().value;
            if (oldest === undefined) break;
            cache.current.delete(oldest);
          }
        }
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        latest.current.onError?.(caught);
        if (mine === epoch.current) setError((latest.current.formatError ?? errorMessage)(caught));
      })
      .finally(() => {
        if (controller.signal.aborted || mine !== epoch.current) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => controller.abort();
    // `latest` is a ref; the filters are represented by `key`.
  }, [enabled, key, reloadToken, keepPrevious, latest]);

  const loadMore = useCallback(async () => {
    const cursor = nextCursor.current;
    if (!cursor || loadingMoreRef.current) return;
    const mine = epoch.current;
    const filters = activeFilters.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError("");
    moreController.current?.abort();
    const controller = new AbortController();
    moreController.current = controller;
    try {
      const page = await latest.current.fetchPage({ filters, cursor, signal: controller.signal });
      if (controller.signal.aborted || mine !== epoch.current) return;
      setMessages((current) => dedupeMessages([...current, ...page.items]));
      setHasMore(page.has_more);
      nextCursor.current = page.next_cursor || "";
    } catch (caught) {
      if (controller.signal.aborted || mine !== epoch.current) return;
      latest.current.onError?.(caught);
      setError((latest.current.formatError ?? errorMessage)(caught));
    } finally {
      // After a filter change the new epoch has already reset these flags.
      if (mine === epoch.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [latest]);

  const reload = useCallback(() => {
    cache.current.clear();
    setRefreshing(true);
    setReloadToken((value) => value + 1);
  }, []);

  const revalidate = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  const prepend = useCallback((items: Message[]) => {
    setMessages((current) => dedupeMessages([...items, ...current]));
  }, []);

  return {
    messages,
    hasMore,
    loading,
    loadingMore,
    refreshing,
    error,
    lastLoadedAt,
    generation,
    loadMore,
    reload,
    revalidate,
    prepend
  };
}
