import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";

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
  fetchOverview,
  fetchSession,
  fetchVisits,
  login,
  logout,
  patchAlertRule,
  patchSource,
  resolveAlert,
} from "./api";
import AdminOverview from "./components/AdminOverview";
import AdminShell from "./components/AdminShell";
import AdminVisits from "./components/AdminVisits";
import FilterPanel from "./components/FilterPanel";
import LoginScreen from "./components/LoginScreen";
import MessageFeed from "./components/MessageFeed";
import OperationsRail from "./components/OperationsRail";
import { useMessageFeed, type FeedFetcher } from "./hooks/useMessageFeed";
import { useNewMessageWatcher } from "./hooks/useNewMessageWatcher";
import { usePolling } from "./hooks/usePolling";
import { useUrlFilters } from "./hooks/useUrlFilters";
import { filtersToParams, parseFilters, withSearch } from "./lib/filters";
import type { AdminOverview as Overview, AdminView, AlertMatch, AlertRule, Filters, Group, OperationSummary, VisitRecord, VisitStats } from "./types";
import { errorHelp, errorMessage, fullDateFormatter, mediaLabel } from "./utils";

const PAGE_LIMIT = 30;
const EMPTY_OPERATIONS: OperationSummary = { sources: [], unhealthy_sources: [] };

const fetchPage: FeedFetcher = ({ filters, cursor, signal }) => fetchMessages(filters, { cursor, limit: PAGE_LIMIT, signal });
const fetchLatestPage = (filters: Filters) => fetchMessages(filters, { limit: PAGE_LIMIT });
const feedErrorText = (caught: unknown) => errorHelp(errorMessage(caught));

export default function App() {
  const initial = useMemo(readFiltersFromUrl, []);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [operations, setOperations] = useState<OperationSummary>(EMPTY_OPERATIONS);
  const [alerts, setAlerts] = useState<AlertMatch[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [draft, setDraft] = useState<Filters>(initial);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [operationsError, setOperationsError] = useState("");
  const [logoutError, setLogoutError] = useState("");
  const [operationAnnouncement, setOperationAnnouncement] = useState("");
  const [operationFocusRequest, setOperationFocusRequest] = useState<{ targetId: string; sequence: number } | null>(null);
  const [view, setView] = useState<AdminView>(readViewFromUrl);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [visits, setVisits] = useState<VisitRecord[]>([]);
  const [visitStats, setVisitStats] = useState<VisitStats | null>(null);

  const filterReturnFocus = useRef<HTMLElement | null>(null);
  const operationFocusSequence = useRef(0);

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

  const { filters, commit } = useUrlFilters({
    read: readFiltersFromUrl,
    toUrl: filtersToUrl,
    onRestore: (next) => {
      setDraft(next);
      setView(readViewFromUrl());
    }
  });

  const feed = useMessageFeed({
    filters,
    enabled: authenticated === true,
    keepPrevious: true,
    fetchPage,
    formatError: feedErrorText,
    onError: handleUnauthorized
  });

  const newMessages = useNewMessageWatcher({
    enabled: authenticated === true,
    filters,
    messages: feed.messages,
    generation: feed.generation,
    fetchPage: fetchLatestPage,
    formatError: feedErrorText,
    onError: handleUnauthorized
  });

  const messageError = feed.error || newMessages.error;

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
    const results = await Promise.allSettled([fetchOperations(), fetchAlerts(), fetchAlertRules(), fetchOverview()]);
    const failures = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    failures.forEach((failure) => handleUnauthorized(failure.reason));
    if (results[0].status === "fulfilled") setOperations(results[0].value);
    if (results[1].status === "fulfilled") setAlerts(results[1].value);
    if (results[2].status === "fulfilled") setRules(results[2].value);
    if (results[3].status === "fulfilled") setOverview(results[3].value);
    if (failures.length) setOperationsError(errorHelp(errorMessage(failures[0].reason)));
  }, [handleUnauthorized]);

  useEffect(() => {
    if (!authenticated) return;
    void loadSources();
    void loadOperations();
  }, [authenticated, loadOperations, loadSources]);

  useEffect(() => {
    if (!authenticated) return;
    if (view === "visits") {
      fetchVisits().then((payload) => {
        setVisits(payload.items);
        setVisitStats(payload.stats);
      }).catch((caught) => handleUnauthorized(caught));
    }
  }, [authenticated, handleUnauthorized, view]);

  useEffect(() => {
    if (!filtersOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFilters();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filtersOpen]);

  usePolling(() => {
    void loadSources();
    void loadOperations();
  }, 30_000, authenticated === true);

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
      setGroups([]);
    } catch (caught) {
      setLogoutError(`退出失败，当前会话仍保持有效。${errorHelp(errorMessage(caught))}`);
    }
  }

  function commitFilters() {
    const next = { ...draft, query: draft.query.trim() };
    const changed = commit(next);
    setDraft(next);
    closeFilters();
    if (!changed) feed.revalidate();
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

  const activeSource = filters.chatId === "all" ? "全部来源" : groups.find((group) => String(group.chat_id) === filters.chatId)?.name || "当前来源";
  const liveMessage = logoutError || operationsError || operationAnnouncement || messageError || sourceError || (newMessages.pending.length ? `发现 ${newMessages.pending.length} 条新消息` : `当前显示 ${feed.messages.length} 条消息`);
  const rail = (
    <OperationsRail
      alerts={alerts}
      groups={groups}
      rules={rules}
      focus={view === "alerts" ? "alerts" : view === "sources" ? "sources" : "all"}
      onAcknowledge={(id) => mutateOperations(() => acknowledgeAlert(id), { successMessage: "规则命中已确认", focusTarget: "alert-operations" })}
      onResolve={(id) => mutateOperations(() => resolveAlert(id), { successMessage: "规则命中已解决", focusTarget: "alert-operations" })}
      onToggleRule={(rule) => mutateOperations(() => patchAlertRule(rule.id, { enabled: !rule.enabled }), { successMessage: rule.enabled ? "规则已停用" : "规则已启用", focusTarget: "alert-operations" })}
      onCreateRule={(name, keyword) => mutateOperations(() => createAlertRule({ name, keyword, source_ids: filters.chatId === "all" ? [] : [Number(filters.chatId)] }), { successMessage: "规则已创建，当前为停用状态", focusTarget: "alert-operations", rethrow: true })}
      onCreateSource={(name, sourceUrl) => mutateOperations(() => createSource({ name, source_url: sourceUrl }), { successMessage: "来源已添加，默认仅管理员可见", focusTarget: "source-operations", reloadSources: true, rethrow: true })}
      onCrawlSource={(chatId) => mutateOperations(() => crawlSource(chatId), { successMessage: "已完成一次来源采集", focusTarget: "source-operations", reloadSources: true })}
      onPatchSource={(group, payload) => mutateOperations(() => patchSource(group.chat_id, payload), { successMessage: payload.public_visible === true ? "来源已公开" : payload.public_visible === false ? "来源已设为私有" : payload.enabled === true ? "来源采集已启用" : "来源采集已停用", focusTarget: "source-operations", reloadSources: true })}
    />
  );

  function changeView(next: AdminView) {
    const params = new URLSearchParams(window.location.search);
    if (next === "overview") params.delete("view");
    else params.set("view", next);
    const search = params.toString();
    const url = `${window.location.pathname}${search ? `?${search}` : ""}`;
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.pushState(null, "", url);
    setView(next);
  }

  return (
    <>
      <a className="skip-link" href="#admin-main">跳到后台内容</a>
      <div className="single-live-region" aria-live="polite" aria-atomic="true">{liveMessage}</div>
      {filtersOpen ? <button className="drawer-scrim" type="button" aria-label="关闭筛选" onClick={closeFilters} /> : null}
      <AdminShell view={view} onChangeView={changeView} onLogout={() => void handleLogout()}>
        <div id="admin-main">
          {logoutError ? <InlineError title="退出失败" message={logoutError} onRetry={() => void handleLogout()} /> : null}
          {sourceError ? <InlineError title="来源状态加载失败" message={sourceError} onRetry={() => void loadSources()} /> : null}
          {operationsError ? <InlineError title="运维状态刷新失败" message={operationsError} onRetry={() => void loadOperations()} /> : null}
          {view === "overview" ? <AdminOverview data={overview} onOpen={changeView} /> : null}
          {view === "sources" ? rail : null}
          {view === "alerts" ? rail : null}
          {view === "visits" ? <AdminVisits items={visits} stats={visitStats} /> : null}
          {view === "messages" ? (
            <div className="admin-messages">
              <FilterPanel draft={draft} groups={groups} open={filtersOpen} onChange={setDraft} onClose={closeFilters} onSubmit={commitFilters} />
              <section className="timeline-column" aria-label="消息工作区">
                <header className="timeline-toolbar">
                  <div><p className="section-kicker">消息检索</p><h2>{activeSource}</h2><p>{mediaLabel(filters.media)}{filters.query ? ` · “${filters.query}”` : ""}</p></div>
                  <Button variant="outline" size="sm" className="filters-toggle" type="button" onClick={openFilters}><SlidersHorizontal size={16} aria-hidden="true" />筛选</Button>
                </header>
                {messageError ? <InlineError title="消息加载失败" message={messageError} onRetry={feed.revalidate} /> : null}
                {newMessages.pending.length ? (
                  <button className="new-message-button" type="button" onClick={() => { feed.prepend(newMessages.pending); newMessages.clear(); }}>
                    {newMessages.pending.length} 条新消息，点击显示
                  </button>
                ) : null}
                <div className="feed-status"><span>{feed.loading ? "正在同步…" : `${feed.messages.length} 条消息`}</span><span>{feed.lastLoadedAt ? `更新于 ${fullDateFormatter.format(feed.lastLoadedAt)}` : "等待首次同步"}</span></div>
                <MessageFeed density="console" hasMore={feed.hasMore} initialLoading={feed.loading} loadingMore={feed.loadingMore} messages={feed.messages} onLoadMore={() => void feed.loadMore()} />
              </section>
            </div>
          ) : null}
        </div>
      </AdminShell>
    </>
  );
}

function InlineError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return <div className="inline-error"><div><strong>{title}</strong><p>{message}</p></div><button type="button" onClick={onRetry}><span className="refresh-mark" aria-hidden="true" />就地重试</button></div>;
}

function readViewFromUrl(): AdminView {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "sources" || view === "visits" || view === "alerts" || view === "messages") return view;
  return "overview";
}

function readFiltersFromUrl(): Filters {
  return parseFilters(window.location.search);
}

/** Filters go into the URL next to whichever view is open. */
function filtersToUrl(filters: Filters) {
  const view = new URLSearchParams(window.location.search).get("view");
  return withSearch(window.location.pathname, filtersToParams(filters, { view }));
}
