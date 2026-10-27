import CountUp from "../bits/CountUp";
import ShinyText from "../bits/ShinyText";
import SpotlightCard from "../bits/SpotlightCard";
import type { VisitRecord, VisitStats } from "../types";
import { formatCount, formatDate } from "../utils";

export default function AdminVisits({
  items,
  stats
}: {
  items: VisitRecord[];
  stats: VisitStats | null;
}) {
  return (
    <div className="admin-stack">
      <header className="admin-page-head">
        <div>
          <h1><ShinyText text="访问记录" /></h1>
          <p>记录前台页面和公开接口访问，不含管理后台自身请求。</p>
        </div>
      </header>
      {stats ? (
        <section className="stat-grid">
          <SpotlightCard className="stat-card"><span>独立用户</span><strong><CountUp to={stats.unique_ips} /></strong><small>按 IP 去重</small></SpotlightCard>
          <SpotlightCard className="stat-card"><span>今日独立 IP</span><strong><CountUp to={stats.today_unique} /></strong><small>今日访问 {formatCount(stats.today)}</small></SpotlightCard>
          <SpotlightCard className="stat-card"><span>近 7 日用户</span><strong><CountUp to={stats.last_7d_unique} /></strong><small>近 24 小时 {formatCount(stats.last_24h)}</small></SpotlightCard>
          <SpotlightCard className="stat-card"><span>累计访问</span><strong><CountUp to={stats.total} /></strong><small>保留约 90 天</small></SpotlightCard>
        </section>
      ) : null}
      <SpotlightCard as="section" className="ops-card">
        <header><h2>最近访问</h2></header>
        {items.length ? (
          <table className="source-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>IP</th>
                <th>路径</th>
                <th>来源 / 设备</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td><small>{formatDate(item.visited_at)}</small></td>
                  <td><strong>{item.ip}</strong></td>
                  <td><small>{item.path}</small></td>
                  <td><small>{item.referer || "直接访问"} · {item.user_agent || "未知客户端"}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="empty-copy">还没有访问记录</p>}
      </SpotlightCard>
    </div>
  );
}
