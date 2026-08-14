import type { AdminOverview, AdminView, Group } from "../types";
import { formatCount, formatDate } from "../utils";

export default function AdminOverview({
  data,
  onOpen
}: {
  data: AdminOverview | null;
  onOpen: (view: AdminView) => void;
}) {
  if (!data) {
    return (
      <div className="admin-stack">
        <header className="admin-page-head">
          <h1>管理中心</h1>
          <p>正在加载概览…</p>
        </header>
      </div>
    );
  }
  const visits = data.visits;
  const sources = data.sources;
  const github = data.github;
  return (
    <div className="admin-stack">
      <header className="admin-page-head">
        <h1>管理中心</h1>
        <p>采集、翻译和访问数据的工作台，与前台阅读页分离。</p>
      </header>
      <section className="stat-grid" aria-label="关键指标">
        <button type="button" className="stat-card" onClick={() => onOpen("visits")}>
          <span>今日独立 IP</span><strong>{formatCount(visits.today_unique)}</strong>
          <small>累计 {formatCount(visits.unique_ips)} 个用户</small>
        </button>
        <button type="button" className="stat-card" onClick={() => onOpen("visits")}>
          <span>今日访问</span><strong>{formatCount(visits.today)}</strong>
          <small>近 24 小时 {formatCount(visits.last_24h)}</small>
        </button>
        <button type="button" className="stat-card" onClick={() => onOpen("sources")}>
          <span>采集来源</span><strong>{formatCount(sources.enabled)} / {formatCount(sources.total)}</strong>
          <small>公开 {formatCount(sources.public)} · 异常 {formatCount(sources.unhealthy)}</small>
        </button>
        <button type="button" className="stat-card" onClick={() => onOpen("github")}>
          <span>GitHub 中文解读</span><strong>{formatCount(github.translated_count)} / {formatCount(github.repository_count)}</strong>
          <small>{github.ai_enabled ? (github.ai_model || "已启用") : "未启用 AI"} · 采集 {github.collection.status}</small>
        </button>
        <button type="button" className="stat-card" onClick={() => onOpen("alerts")}>
          <span>新规则命中</span><strong>{formatCount(data.alerts.new_count)}</strong>
          <small>进入规则模块处理</small>
        </button>
      </section>
      <section className="ops-card">
        <header><h2>渠道采集状态</h2></header>
        <SourceStatusTable groups={sources.items} />
      </section>
    </div>
  );
}

export function SourceStatusTable({ groups }: { groups: Group[] }) {
  if (!groups.length) return <p className="empty-copy">暂无来源配置</p>;
  return (
    <table className="source-table">
      <thead>
        <tr>
          <th>来源</th>
          <th>适配器</th>
          <th>状态</th>
          <th>上次成功</th>
          <th>抓取 / 入库</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <tr key={group.chat_id}>
            <td>
              <strong>{group.name}</strong>
              <small>{group.public_visible ? "公开" : "私有"} · {group.enabled === false ? "停用" : "采集中"}</small>
            </td>
            <td><small>{group.adapter || group.source_type}</small></td>
            <td><span className={`health-dot health-${group.health_status}`} /> {healthText(group.health_status)}</td>
            <td><small>{group.last_success_at ? formatDate(group.last_success_at) : "尚无"}</small></td>
            <td><small>{group.fetched_count} / {group.saved_count}</small></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function healthText(status: Group["health_status"]) {
  return { healthy: "正常", stale: "延迟", error: "异常", unknown: "未运行" }[status];
}
