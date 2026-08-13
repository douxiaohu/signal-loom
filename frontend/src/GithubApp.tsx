import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, GitBranch, Search } from "lucide-react";

import { fetchGithubRankings, type GithubFilters } from "./github-api";
import GithubRepoCard from "./components/GithubRepoCard";
import type { GithubPeriod, GithubRankingResponse, GithubRepository, GithubSort } from "./types";
import { formatCount, formatDate } from "./utils";
import { ThemeSwitcher } from "./theme";


const PAGE_SIZE = 24;
const periodOptions: Array<{ value: GithubPeriod; label: string; caption: string }> = [
  { value: "daily", label: "日榜", caption: "24H" },
  { value: "weekly", label: "周榜", caption: "7D" },
  { value: "monthly", label: "月榜", caption: "30D" }
];
const sortOptions: Array<{ value: GithubSort; label: string }> = [
  { value: "activity", label: "综合活跃度" },
  { value: "star_growth", label: "Stars 增长" },
  { value: "stars", label: "Stars 总量" },
  { value: "forks", label: "Forks 总量" },
  { value: "recent", label: "最近推送" }
];


function filtersFromUrl(): GithubFilters {
  const params = new URLSearchParams(window.location.search);
  const period = params.get("period");
  const sort = params.get("sort");
  return {
    period: period === "weekly" || period === "monthly" ? period : "daily",
    language: params.get("language") || "",
    query: params.get("query") || "",
    sort: sortOptions.some((option) => option.value === sort) ? sort as GithubSort : "activity"
  };
}


function syncUrl(filters: GithubFilters) {
  const params = new URLSearchParams();
  if (filters.period !== "daily") params.set("period", filters.period);
  if (filters.language) params.set("language", filters.language);
  if (filters.query) params.set("query", filters.query);
  if (filters.sort !== "activity") params.set("sort", filters.sort);
  const target = params.size ? `/github?${params}` : "/github";
  window.history.replaceState(null, "", target);
}


export default function GithubApp() {
  const initial = useMemo(filtersFromUrl, []);
  const [filters, setFilters] = useState<GithubFilters>(initial);
  const [draftQuery, setDraftQuery] = useState(initial.query);
  const [data, setData] = useState<GithubRankingResponse | null>(null);
  const [repositories, setRepositories] = useState<GithubRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const requestSequence = useRef(0);

  useEffect(() => {
    syncUrl(filters);
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    fetchGithubRankings(filters, { perPage: PAGE_SIZE, signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setData(payload);
        setRepositories(payload.items);
      })
      .catch((caught) => {
        if (!controller.signal.aborted && sequence === requestSequence.current) {
          setError(caught instanceof Error ? caught.message : "排行榜加载失败");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && sequence === requestSequence.current) setLoading(false);
      });
    return () => controller.abort();
  }, [filters, refreshTick]);

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshTick((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  function updateFilters(patch: Partial<GithubFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
  }

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    updateFilters({ query: draftQuery.trim() });
  }

  async function loadMore() {
    if (!data?.has_more || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await fetchGithubRankings(filters, { page: data.page + 1, perPage: PAGE_SIZE });
      setRepositories((current) => [...current, ...next.items.filter((item) => !current.some((repo) => repo.id === item.id))]);
      setData(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  }

  const statusText = data?.collection.last_updated
    ? `数据更新于 ${formatDate(data.collection.last_updated)}`
    : "等待首次 GitHub 数据采集";

  return (
    <div className="github-shell">
      <a className="skip-link" href="#github-ranking">跳到排行榜</a>
      <header className="github-header">
        <a className="github-brand" href="/github" aria-label="GitHub 趋势雷达首页">
          <GitBranch size={28} aria-hidden="true" />
          <span><strong>GitHub 趋势雷达</strong><small>开放项目活跃度与特征检索</small></span>
        </a>
        <div className="header-actions github-header-actions">
          <nav className="surface-switcher" aria-label="公开专区">
            <a href="/">频道资讯</a><a className="active" href="/github" aria-current="page">GitHub 排行榜</a>
          </nav>
          <ThemeSwitcher />
        </div>
        <form className="github-search" role="search" onSubmit={submitSearch}>
          <Search size={17} aria-hidden="true" />
          <label className="sr-only" htmlFor="github-query">搜索仓库、描述、主题或语言</label>
          <input id="github-query" type="search" value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} placeholder="搜索仓库、描述、topic、许可证…" />
          <button type="submit">搜索</button>
        </form>
      </header>

      <section className="github-hero">
        <div>
          <p className="section-kicker">OPEN SOURCE PULSE</p>
          <h1>找到正在加速的开源项目</h1>
          <p>基于周期快照追踪 Stars、Forks、议题变化与推送新鲜度，并记录语言、主题、许可证等仓库特征。</p>
        </div>
        <dl className="github-stats">
          <div><dt><span className="stat-dot" aria-hidden="true" />候选仓库</dt><dd>{formatCount(data?.total || 0)}</dd></div>
          <div><dt><Activity size={14} />语言覆盖</dt><dd>{formatCount(data?.languages.length || 0)}</dd></div>
          <div><dt><span className="refresh-mark" aria-hidden="true" />采集状态</dt><dd className={`collection-${data?.collection.status || "never"}`}>{data?.collection.refreshing ? "更新中" : data?.collection.status === "succeeded" ? "正常" : data?.collection.status === "partial" ? "部分" : data?.collection.status === "failed" ? "异常" : "待采集"}</dd></div>
        </dl>
      </section>

      <main className="github-content">
        <aside className="github-controls" aria-label="排行榜筛选">
          <div className="github-period-tabs">
            {periodOptions.map((option) => (
              <button key={option.value} className={filters.period === option.value ? "active" : ""} onClick={() => updateFilters({ period: option.value })}>
                <span>{option.label}</span><small>{option.caption}</small>
              </button>
            ))}
          </div>
          <div className="github-select-row">
            <label><span>编程语言</span><select value={filters.language} onChange={(event) => updateFilters({ language: event.target.value })}>
              <option value="">全部语言</option>
              {data?.languages.map((item) => <option key={item.language} value={item.language}>{item.language} · {item.repository_count}</option>)}
            </select></label>
            <label><span>排序方式</span><select value={filters.sort} onChange={(event) => updateFilters({ sort: event.target.value as GithubSort })}>
              {sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></label>
          </div>
          <div className="github-filter-note"><span>{filters.language || "全部语言"} · {periodOptions.find((item) => item.value === filters.period)?.label} · {sortOptions.find((item) => item.value === filters.sort)?.label}</span></div>
        </aside>

        <section className="github-ranking" id="github-ranking" aria-busy={loading}>
          <header className="github-ranking-head">
            <div><p className="section-kicker">LIVE RANKING</p><h2>{filters.query ? `“${filters.query}” 的项目结果` : `${filters.language || "全语言"}活跃榜`}</h2></div>
            <span className={data?.collection.refreshing ? "is-refreshing" : ""}><span className="refresh-mark" aria-hidden="true" />{loading ? "正在读取…" : statusText}</span>
          </header>
          {error ? <div className="inline-error"><strong>加载失败</strong><span>{error}</span></div> : null}
          {!loading && !repositories.length && !error ? <div className="github-empty"><GitBranch size={34} /><strong>没有匹配的仓库</strong><span>尝试更换语言、周期或搜索关键词。</span></div> : null}
          <div className="github-repo-list">
            {repositories.map((repository) => <GithubRepoCard key={repository.id} repository={repository} period={filters.period} />)}
          </div>
          {loading && !repositories.length ? <div className="github-skeletons" aria-label="正在加载排行榜">{[1, 2, 3].map((item) => <div key={item} />)}</div> : null}
          {data?.has_more ? <button className="load-more github-load-more" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "正在加载…" : "查看更多项目"}</button> : null}
          {repositories.some((item) => !item.history_complete) ? <p className="github-baseline-note">首次采集阶段使用仓库热度与推送新鲜度生成初始排序；积累满当前周期后自动切换为真实增量排名。</p> : null}
        </section>
      </main>
    </div>
  );
}
