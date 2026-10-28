import { useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";

import { fetchMessages } from "./api";
import AdminOverview from "./components/AdminOverview";
import AdminShell from "./components/AdminShell";
import AdminVisits from "./components/AdminVisits";
import FilterPanel from "./components/FilterPanel";
import InlineError from "./components/InlineError";
import LoginScreen from "./components/LoginScreen";
import MessageFeed from "./components/MessageFeed";
import OperationsRail from "./components/OperationsRail";
import { useAdminData } from "./hooks/useAdminData";
import { useAdminSession } from "./hooks/useAdminSession";
import { useAdminView } from "./hooks/useAdminView";
import { useFilterDrawer } from "./hooks/useFilterDrawer";
import { useMessageFeed, type FeedFetcher } from "./hooks/useMessageFeed";
import { useNewMessageWatcher } from "./hooks/useNewMessageWatcher";
import { useOperationsActions } from "./hooks/useOperationsActions";
import { useUrlFilters } from "./hooks/useUrlFilters";
import { useVisits } from "./hooks/useVisits";
import { filtersToParams, parseFilters, withSearch } from "./lib/filters";
import type { Filters } from "./types";
import { errorHelp, errorMessage, fullDateFormatter, mediaLabel } from "./utils";

const PAGE_LIMIT = 30;

const fetchPage: FeedFetcher = ({ filters, cursor, signal }) => fetchMessages(filters, { cursor, limit: PAGE_LIMIT, signal });
const fetchLatestPage = (filters: Filters) => fetchMessages(filters, { limit: PAGE_LIMIT });
const feedErrorText = (caught: unknown) => errorHelp(errorMessage(caught));

const filtersFromUrl = () => parseFilters(window.location.search);

/** Filters go into the URL next to whichever view is open. */
function filtersToUrl(filters: Filters) {
  const view = new URLSearchParams(window.location.search).get("view");
  return withSearch(window.location.pathname, filtersToParams(filters, { view }));
}

export default function App() {
  const initial = useMemo(filtersFromUrl, []);
  const session = useAdminSession();
  const authenticated = session.authenticated === true;
  const { view, changeView, syncFromUrl } = useAdminView();
  const [draft, setDraft] = useState<Filters>(initial);
  const drawer = useFilterDrawer();

  const { filters, commit } = useUrlFilters({
    read: filtersFromUrl,
    toUrl: filtersToUrl,
    onRestore: (next) => {
      setDraft(next);
      syncFromUrl();
    }
  });

  const feed = useMessageFeed({
    filters,
    enabled: authenticated,
    keepPrevious: true,
    fetchPage,
    formatError: feedErrorText,
    onError: session.handleUnauthorized
  });

  const newMessages = useNewMessageWatcher({
    enabled: authenticated,
    filters,
    messages: feed.messages,
    generation: feed.generation,
    fetchPage: fetchLatestPage,
    formatError: feedErrorText,
    onError: session.handleUnauthorized
  });

  const data = useAdminData({ authenticated, onUnauthorized: session.handleUnauthorized });
  const visits = useVisits({ authenticated, active: view === "visits", onUnauthorized: session.handleUnauthorized });
  const actions = useOperationsActions({
    data,
    scopeChatId: filters.chatId,
    onUnauthorized: session.handleUnauthorized,
    onStart: session.clearLogoutError
  });

  const messageError = feed.error || newMessages.error;

  function commitFilters() {
    const next = { ...draft, query: draft.query.trim() };
    const changed = commit(next);
    setDraft(next);
    drawer.close();
    if (!changed) feed.revalidate();
  }

  async function handleLogout() {
    actions.clearAnnouncement();
    await session.signOut();
  }

  if (session.authenticated === null) return <div className="boot-screen"><span className="boot-line" />正在建立管理会话…</div>;
  if (!session.authenticated) return <LoginScreen error={session.loginError} loading={session.loginLoading} onLogin={session.signIn} />;

  const activeSource = filters.chatId === "all" ? "全部来源" : data.sources.find((group) => String(group.chat_id) === filters.chatId)?.name || "当前来源";
  const liveMessage = session.logoutError || data.operationsError || actions.announcement || messageError || data.sourceError || (newMessages.pending.length ? `发现 ${newMessages.pending.length} 条新消息` : `当前显示 ${feed.messages.length} 条消息`);
  const rail = (
    <OperationsRail
      alerts={data.alerts}
      groups={data.sources}
      rules={data.rules}
      busy={actions.busy}
      focus={view === "alerts" ? "alerts" : view === "sources" ? "sources" : "all"}
      {...actions.handlers}
    />
  );

  return (
    <>
      <a className="skip-link" href="#admin-main">跳到后台内容</a>
      <div className="single-live-region" aria-live="polite" aria-atomic="true">{liveMessage}</div>
      {drawer.open ? <button className="drawer-scrim" type="button" aria-label="关闭筛选" onClick={drawer.close} /> : null}
      <AdminShell view={view} onChangeView={changeView} onLogout={() => void handleLogout()}>
        <div id="admin-main">
          {session.logoutError ? <InlineError title="退出失败" message={session.logoutError} onRetry={() => void handleLogout()} /> : null}
          {data.sourceError ? <InlineError title="来源状态加载失败" message={data.sourceError} onRetry={() => void data.loadSources()} /> : null}
          {data.operationsError ? <InlineError title="运维状态刷新失败" message={data.operationsError} onRetry={() => void data.loadOperations()} /> : null}
          {view === "overview" ? <AdminOverview data={data.overview} onOpen={changeView} /> : null}
          {view === "sources" ? rail : null}
          {view === "alerts" ? rail : null}
          {view === "visits" ? (
            <>
              {visits.error ? <InlineError title="访问记录加载失败" message={visits.error} onRetry={visits.reload} /> : null}
              <AdminVisits items={visits.items} stats={visits.stats} loading={visits.loading} />
            </>
          ) : null}
          {view === "messages" ? (
            <div className="admin-messages">
              <FilterPanel draft={draft} groups={data.sources} open={drawer.open} onChange={setDraft} onClose={drawer.close} onSubmit={commitFilters} />
              <section className="timeline-column" aria-label="消息工作区">
                <header className="timeline-toolbar">
                  <div><p className="section-kicker">消息检索</p><h2>{activeSource}</h2><p>{mediaLabel(filters.media)}{filters.query ? ` · “${filters.query}”` : ""}</p></div>
                  <Button variant="outline" size="sm" className="filters-toggle" type="button" onClick={drawer.show}><SlidersHorizontal size={16} aria-hidden="true" />筛选</Button>
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
