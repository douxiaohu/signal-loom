import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";

import {
  acknowledgeAlert,
  ApiError,
  crawlSource,
  createAlertRule,
  createSource,
  fetchAlertRules,
  fetchAlerts,
  fetchGroups,
  fetchMessages,
  fetchOperations,
  fetchSession,
  login,
  logout,
  patchAlertRule,
  patchSource,
  resolveAlert,
} from "./api";
import FilterPanel from "./components/FilterPanel";
import LoginScreen from "./components/LoginScreen";
import MessageFeed from "./components/MessageFeed";
import OperationsRail from "./components/OperationsRail";
import StatusBand from "./components/StatusBand";
import type { AlertMatch, AlertRule, Filters, Group, HealthStatus, Message, OperationSummary } from "./types";
import { errorHelp, errorMessage, fullDateFormatter, isMediaFilter, mediaLabel } from "./utils";

const PAGE_LIMIT = 30;
const EMPTY_OPERATIONS: OperationSummary = { sources: [], unhealthy_sources: [] };

export default function App() {
  const initial = useMemo(readFiltersFromUrl, []);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [operations, setOperations] = useState<OperationSummary>(EMPTY_OPERATIONS);
  const [alerts, setAlerts] = useState<AlertMatch[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [filters, setFilters] = useState<Filters>(initial);
  const [draft, setDraft] = useState<Filters>(initial);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState("");
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [pendingNew, setPendingNew] = useState<Message[]>([]);
  const [sourceError, setSourceError] = useState("");
  const [messageError, setMessageError] = useState("");
  const [operationsError, setOperationsError] = useState("");
  const [logoutError, setLogoutError] = useState("");
  const [operationAnnouncement, setOperationAnnouncement] = useState("");
  const [operationFocusRequest, setOperationFocusRequest] = useState<{ targetId: string; sequence: number } | null>(null);
  const [lastMessageLoad, setLastMessageLoad] = useState("");
  const [messageRefreshKey, setMessageRefreshKey] = useState(0);

  const requestSequence = useRef(0);
  const messageController = useRef<AbortController | null>(null);
  const pageController = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);
  const filtersRef = useRef(filters);
  const messagesRef = useRef(messages);
  const filterReturnFocus = useRef<HTMLElement | null>(null);
  const operationFocusSequence = useRef(0);
  useEffect(() => { filtersRef.current = filters; }, [filters]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    if (!operationFocusRequest) return;
    document.getElementById(operationFocusRequest.targetId)?.focus();
  }, [operationFocusRequest]);

  useEffect(() => {
    let active = true;
    fetchSession()
      .then((session) => { if (active) setAuthenticated(session.authenticated); })
      .catch(() => { if (active) setAuthenticated(false); });
    return () => { active = false; };
  }, []);

  const handleUnauthorized = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) setAuthenticated(false);
  }, []);

  const loadSources = useCallback(async () => {
    setSourceError("");
    try {
      setGroups(await fetchGroups());
    } catch (caught) {
      handleUnauthorized(caught);
      setSourceError(errorHelp(errorMessage(caught)));
    }
  }, [handleUnauthorized]);

  const loadOperations = useCallback(async () => {
    setOperationsError("");
    const results = await Promise.allSettled([fetchOperations(), fetchAlerts(), fetchAlertRules()]);
    const failures = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    failures.forEach((failure) => handleUnauthorized(failure.reason));
    if (results[0].status === "fulfilled") setOperations(results[0].value);
    if (results[1].status === "fulfilled") setAlerts(results[1].value);
    if (results[2].status === "fulfilled") setRules(results[2].value);
    if (failures.length) setOperationsError(errorHelp(errorMessage(failures[0].reason)));
  }, [handleUnauthorized]);

  useEffect(() => {
    if (!authenticated) return;
    void loadSources();
    void loadOperations();
  }, [authenticated, loadOperations, loadSources]);

  useEffect(() => {
    if (!authenticated) return;
    const sequence = ++requestSequence.current;
    messageController.current?.abort();
    pageController.current?.abort();
    const controller = new AbortController();
    messageController.current = controller;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setInitialLoading(true);
    setMessageError("");
    setPendingNew([]);
    fetchMessages(filters, { limit: PAGE_LIMIT, signal: controller.signal })
      .then((page) => {
        if (sequence !== requestSequence.current || controller.signal.aborted) return;
        setMessages(dedupeMessages(page.items));
        setHasMore(page.has_more);
        setNextCursor(page.next_cursor || "");
        setLastMessageLoad(fullDateFormatter.format(new Date()));
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        handleUnauthorized(caught);
        if (sequence === requestSequence.current) setMessageError(errorHelp(errorMessage(caught)));
      })
      .finally(() => {
        if (sequence === requestSequence.current) setInitialLoading(false);
      });
    return () => controller.abort();
  }, [authenticated, filters, handleUnauthorized, messageRefreshKey]);

  useEffect(() => {
    function restoreFilters() {
      const next = readFiltersFromUrl();
      setDraft(next);
      setFilters(next);
    }
    window.addEventListener("popstate", restoreFilters);
    return () => window.removeEventListener("popstate", restoreFilters);
  }, []);

  useEffect(() => {
    if (!filtersOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFilters();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filtersOpen]);

  useEffect(() => {
    if (!authenticated) return;
    const refreshHealth = () => {
      if (document.visibilityState === "hidden") return;
      void loadSources();
      void loadOperations();
    };
    const timer = window.setInterval(refreshHealth, 30_000);
    return () => window.clearInterval(timer);
  }, [authenticated, loadOperations, loadSources]);

  const checkForNewMessages = useCallback(async () => {
    if (!authenticated || document.visibilityState === "hidden") return;
    const snapshot = filtersRef.current;
    const key = filterKey(snapshot);
    try {
      const page = await fetchMessages(snapshot, { limit: PAGE_LIMIT });
      if (key !== filterKey(filtersRef.current)) return;
      const visibleIds = new Set(messagesRef.current.map((message) => message.id));
      setPendingNew((current) => dedupeMessages([...page.items.filter((item) => !visibleIds.has(item.id)), ...current]));
    } catch (caught) {
      handleUnauthorized(caught);
      setMessageError(errorHelp(errorMessage(caught)));
    }
  }, [authenticated, handleUnauthorized]);

  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setInterval(() => void checkForNewMessages(), 60_000);
    return () => window.clearInterval(timer);
  }, [authenticated, checkForNewMessages]);

  async function handleLogin(apiKey: string) {
    setLoginLoading(true);
    setLoginError("");
    setLogoutError("");
    try {
      await login(apiKey);
      setAuthenticated(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) setLoginError("尝试次数过多，请稍后再试。");
      else if (caught instanceof ApiError && caught.status === 401) setLoginError("管理密钥无效。");
      else setLoginError("登录服务暂时不可用，请检查网络或服务状态后重试。");
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    setOperationAnnouncement("");
    setLogoutError("");
    try {
      await logout();
      setAuthenticated(false);
      setMessages([]);
      setGroups([]);
    } catch (caught) {
      setLogoutError(`退出失败，当前会话仍保持有效。${errorHelp(errorMessage(caught))}`);
    }
  }

  function commitFilters() {
    const next = { ...draft, query: draft.query.trim() };
    const url = filtersToUrl(next);
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.pushState(null, "", url);
    setFilters(next);
    setDraft(next);
    closeFilters();
    if (filterKey(next) === filterKey(filters)) setMessageRefreshKey((value) => value + 1);
  }

  async function loadMore() {
    const cursor = nextCursor;
    if (!cursor || !hasMore || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMessageError("");
    pageController.current?.abort();
    const controller = new AbortController();
    pageController.current = controller;
    const snapshot = filters;
    try {
      const page = await fetchMessages(snapshot, { cursor, limit: PAGE_LIMIT, signal: controller.signal });
      if (filterKey(snapshot) !== filterKey(filtersRef.current)) return;
      setMessages((current) => dedupeMessages([...current, ...page.items]));
      setHasMore(page.has_more);
      setNextCursor(page.next_cursor || "");
    } catch (caught) {
      if (!controller.signal.aborted) {
        handleUnauthorized(caught);
        setMessageError(errorHelp(errorMessage(caught)));
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }

  async function mutateOperations(
    action: () => Promise<unknown>,
    feedback: { successMessage: string; focusTarget: "alert-operations" | "source-operations"; reloadSources?: boolean; rethrow?: boolean }
  ) {
    setOperationsError("");
    setLogoutError("");
    setOperationAnnouncement("");
    try {
      await action();
      if (feedback.reloadSources) await loadSources();
      await loadOperations();
      setOperationAnnouncement(feedback.successMessage);
      setOperationFocusRequest({ targetId: feedback.focusTarget, sequence: ++operationFocusSequence.current });
    }
    catch (caught) {
      handleUnauthorized(caught);
      setOperationsError(errorHelp(errorMessage(caught)));
      if (feedback.rethrow) throw caught;
    }
  }

  function openFilters() {
    filterReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFiltersOpen(true);
  }

  function closeFilters() {
    setFiltersOpen(false);
    window.requestAnimationFrame(() => filterReturnFocus.current?.focus());
  }

  if (authenticated === null) return <div className="boot-screen"><span className="boot-line" />正在建立管理会话…</div>;
  if (!authenticated) return <LoginScreen error={loginError} loading={loginLoading} onLogin={handleLogin} />;

  const overallHealth = aggregateHealth(groups);
  const healthyCount = groups.filter((group) => group.health_status === "healthy").length;
  const activeSource = filters.chatId === "all" ? "全部来源" : groups.find((group) => String(group.chat_id) === filters.chatId)?.name || "当前来源";
  const liveMessage = logoutError || operationsError || operationAnnouncement || messageError || sourceError || (pendingNew.length ? `发现 ${pendingNew.length} 条新消息` : `当前显示 ${messages.length} 条消息`);

  return (
    <>
      <a className="skip-link" href="#message-list">跳到消息时间线</a>
      <div className="console-shell">
        <StatusBand health={overallHealth} healthyCount={healthyCount} messageCount={messages.length} sourceCount={groups.length} onLogout={() => void handleLogout()} onOpenFilters={openFilters} />
        <div className="single-live-region" aria-live="polite" aria-atomic="true">{liveMessage}</div>
        {filtersOpen ? <button className="drawer-scrim" type="button" aria-label="关闭筛选" onClick={closeFilters} /> : null}
        <div className="console-grid">
          <FilterPanel draft={draft} groups={groups} open={filtersOpen} onChange={setDraft} onClose={closeFilters} onSubmit={commitFilters} />
          <section className="timeline-column" aria-label="消息工作区">
            <header className="timeline-toolbar">
              <div><p className="section-kicker">消息时间线</p><h2>{activeSource}</h2><p>{mediaLabel(filters.media)}{filters.query ? ` · “${filters.query}”` : ""}</p></div>
              <button className="secondary-button" type="button" onClick={openFilters}><SlidersHorizontal size={16} aria-hidden="true" />筛选</button>
            </header>
            {logoutError ? <InlineError title="退出失败" message={logoutError} onRetry={() => void handleLogout()} /> : null}
            {sourceError ? <InlineError title="来源状态加载失败" message={sourceError} onRetry={() => void loadSources()} /> : null}
            {messageError ? <InlineError title="消息加载失败" message={messageError} onRetry={() => setMessageRefreshKey((value) => value + 1)} /> : null}
            {pendingNew.length ? (
              <button className="new-message-button" type="button" onClick={() => { setMessages((current) => dedupeMessages([...pendingNew, ...current])); setPendingNew([]); }}>
                {pendingNew.length} 条新消息，点击显示
              </button>
            ) : null}
            <div className="feed-status"><span>{initialLoading ? "正在同步…" : `${messages.length} 条消息`}</span><span>{lastMessageLoad ? `更新于 ${lastMessageLoad}` : "等待首次同步"}</span></div>
            <MessageFeed density="console" hasMore={hasMore} initialLoading={initialLoading} loadingMore={loadingMore} messages={messages} onLoadMore={() => void loadMore()} />
          </section>
          <div>
            {operationsError ? <InlineError title="运维状态刷新失败" message={operationsError} onRetry={() => void loadOperations()} /> : null}
            <OperationsRail
              alerts={alerts}
              groups={groups}
              rules={rules}
              onAcknowledge={(id) => mutateOperations(() => acknowledgeAlert(id), { successMessage: "规则命中已确认", focusTarget: "alert-operations" })}
              onResolve={(id) => mutateOperations(() => resolveAlert(id), { successMessage: "规则命中已解决", focusTarget: "alert-operations" })}
              onToggleRule={(rule) => mutateOperations(() => patchAlertRule(rule.id, { enabled: !rule.enabled }), { successMessage: rule.enabled ? "规则已停用" : "规则已启用", focusTarget: "alert-operations" })}
              onCreateRule={(name, keyword) => mutateOperations(() => createAlertRule({ name, keyword, source_ids: filters.chatId === "all" ? [] : [Number(filters.chatId)] }), { successMessage: "规则已创建，当前为停用状态", focusTarget: "alert-operations", rethrow: true })}
              onCreateSource={(name, sourceUrl) => mutateOperations(() => createSource({ name, source_url: sourceUrl }), { successMessage: "来源已添加，默认仅管理员可见", focusTarget: "source-operations", reloadSources: true, rethrow: true })}
              onCrawlSource={(chatId) => mutateOperations(() => crawlSource(chatId), { successMessage: "已完成一次来源采集", focusTarget: "source-operations", reloadSources: true })}
              onPatchSource={(group, payload) => mutateOperations(() => patchSource(group.chat_id, payload), { successMessage: payload.public_visible === true ? "来源已公开" : payload.public_visible === false ? "来源已设为私有" : payload.enabled === true ? "来源采集已启用" : "来源采集已停用", focusTarget: "source-operations", reloadSources: true })}
            />
          </div>
        </div>
      </div>
    </>
  );
}

function InlineError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return <div className="inline-error"><div><strong>{title}</strong><p>{message}</p></div><button type="button" onClick={onRetry}><span className="refresh-mark" aria-hidden="true" />就地重试</button></div>;
}

function readFiltersFromUrl(): Filters {
  const params = new URLSearchParams(window.location.search);
  const media = params.get("media") || "all";
  return { chatId: params.get("chat_id") || "all", media: isMediaFilter(media) ? media : "all", query: params.get("query") || "" };
}

function filtersToUrl(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.chatId !== "all") params.set("chat_id", filters.chatId);
  if (filters.media !== "all") params.set("media", filters.media);
  if (filters.query) params.set("query", filters.query);
  const search = params.toString();
  return `${window.location.pathname}${search ? `?${search}` : ""}`;
}

function filterKey(filters: Filters) { return `${filters.chatId}\u0000${filters.media}\u0000${filters.query.trim()}`; }
function dedupeMessages(items: Message[]) { return [...new Map(items.map((item) => [item.id, item])).values()]; }
function aggregateHealth(groups: Group[]): HealthStatus {
  if (!groups.length || groups.every((group) => group.health_status === "unknown")) return "unknown";
  if (groups.some((group) => group.health_status === "error")) return "error";
  if (groups.some((group) => group.health_status === "stale" || group.health_status === "unknown")) return "stale";
  return "healthy";
}
