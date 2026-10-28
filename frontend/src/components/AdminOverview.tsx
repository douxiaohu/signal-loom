import { Activity, RadioTower, ShieldAlert, Users } from "lucide-react";

import CountUp, { CountUpPair } from "../bits/CountUp";
import ShinyText from "../bits/ShinyText";
import SpotlightCard from "../bits/SpotlightCard";
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
          <div>
            <h1><ShinyText text="管理中心" /></h1>
            <p>正在加载概览…</p>
          </div>
        </header>
      </div>
    );
  }
  const visits = data.visits;
  const sources = data.sources;
  return (
    <div className="admin-stack">
      <header className="admin-page-head">
        <div>
          <h1><ShinyText text="管理中心" /></h1>
          <p>采集、规则和访问数据的工作台，与前台阅读页分离。</p>
        </div>
      </header>
      <section className="stat-grid" aria-label="关键指标">
        <SpotlightCard as="button" type="button" className="stat-card" onClick={() => onOpen("visits")}>
          <span className="stat-icon"><Users size={16} aria-hidden="true" /></span>
          <span>今日独立 IP</span><strong><CountUp to={visits.today_unique} /></strong>
          <small>累计 {formatCount(visits.unique_ips)} 个用户</small>
        </SpotlightCard>
        <SpotlightCard as="button" type="button" className="stat-card" onClick={() => onOpen("visits")}>
          <span className="stat-icon"><Activity size={16} aria-hidden="true" /></span>
          <span>今日访问</span><strong><CountUp to={visits.today} /></strong>
          <small>近 24 小时 {formatCount(visits.last_24h)}</small>
        </SpotlightCard>
        <SpotlightCard as="button" type="button" className="stat-card" onClick={() => onOpen("sources")}>
          <span className="stat-icon"><RadioTower size={16} aria-hidden="true" /></span>
          <span>采集来源</span><strong><CountUpPair left={sources.enabled} right={sources.total} /></strong>
          <small>公开 {formatCount(sources.public)} · 异常 {formatCount(sources.unhealthy)}</small>
        </SpotlightCard>
        <SpotlightCard as="button" type="button" className="stat-card" onClick={() => onOpen("alerts")}>
          <span className="stat-icon"><ShieldAlert size={16} aria-hidden="true" /></span>
          <span>新规则命中</span><strong><CountUp to={data.alerts.new_count} /></strong>
          <small>进入规则模块处理</small>
        </SpotlightCard>
      </section>
      <AlertLifecycleOverview alerts={data.alerts} onOpen={onOpen} />
      <SpotlightCard as="section" className="ops-card">
        <header><h2>渠道采集状态</h2></header>
        <SourceStatusTable groups={sources.items} />
      </SpotlightCard>
    </div>
  );
}

function AlertLifecycleOverview({ alerts, onOpen }: { alerts: AdminOverview["alerts"]; onOpen: (view: AdminView) => void }) {
  const trend = alerts.trend ?? [];
  return (
    <SpotlightCard as="section" className="ops-card" aria-label="规则生命周期">
      <header><h2>规则生命周期</h2></header>
      <div className="stat-grid">
        <SpotlightCard as="button" type="button" className="stat-card" onClick={() => onOpen("alerts")}><span>启用规则</span><strong><CountUpPair left={alerts.enabled_rule_count ?? 0} right={alerts.rule_count ?? 0} /></strong><small>当前规则状态</small></SpotlightCard>
        <SpotlightCard as="button" type="button" className="stat-card" onClick={() => onOpen("alerts")}><span>待处理命中</span><strong><CountUp to={alerts.pending_count ?? alerts.new_count} /></strong><small>新建 {formatCount(alerts.new_count)}</small></SpotlightCard>
        <SpotlightCard as="button" type="button" className="stat-card" onClick={() => onOpen("alerts")}><span>平均待处理时长</span><strong>{formatAge(alerts.pending_age_minutes ?? 0)}</strong><small>确认 {formatCount(alerts.acknowledged_count ?? 0)} · 解决 {formatCount(alerts.resolved_count ?? 0)}</small></SpotlightCard>
      </div>
      <div aria-label="规则命中趋势" role="img" className="alert-trend">{trend.map((point) => <span key={point.date}><strong><CountUp to={point.count} duration={0.6} /></strong><small>{point.date}</small></span>)}</div>
    </SpotlightCard>
  );
}

function formatAge(minutes: number) {
  if (minutes < 60) return `${minutes}分钟`;
  return `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分钟` : ""}`;
}

function SourceStatusTable({ groups }: { groups: Group[] }) {
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
