import { Activity, RadioTower, ShieldAlert, Users } from "lucide-react";
import type { CSSProperties } from "react";

import CountUp, { CountUpPair } from "../bits/CountUp";
import ShinyText from "../bits/ShinyText";
import SpotlightCard from "../bits/SpotlightCard";
import type { AdminOverview, AdminView, Group, VisitTrendPoint } from "../types";
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
      <VisitsTrendChart points={visits.trend ?? []} />
      <AlertLifecycleOverview alerts={data.alerts} onOpen={onOpen} />
      <SpotlightCard as="section" className="ops-card">
        <header><h2>渠道采集状态</h2></header>
        <SourceHealthSummary groups={sources.items} />
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
      <AlertTrendChart trend={trend} />
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

/** The recent rule-match trend as a small bar chart; each bar's height is its count over the window's peak. */
function AlertTrendChart({ trend }: { trend: Array<{ date: string; count: number }> }) {
  const peak = Math.max(1, ...trend.map((point) => point.count));
  return (
    <div aria-label="规则命中趋势" role="img" className="alert-trend">
      {trend.map((point, index) => (
        <span
          key={point.date}
          className={index === trend.length - 1 ? "is-last" : undefined}
          style={{ "--bar": `${Math.max(4, Math.round((point.count / peak) * 72))}px` } as CSSProperties}
        >
          <strong><CountUp to={point.count} duration={0.6} /></strong>
          <i className="alert-bar" aria-hidden="true" />
          <small>{point.date}</small>
        </span>
      ))}
    </div>
  );
}

/** The recent daily visits as an area chart; the series is each day's unique visitors. */
function VisitsTrendChart({ points }: { points: VisitTrendPoint[] }) {
  if (points.length < 2) return null;
  const width = 560;
  const height = 132;
  const padTop = 12;
  const padBottom = 4;
  const padX = 4;
  const values = points.map((point) => point.unique);
  const peak = Math.max(1, ...values);
  const n = points.length;
  const x = (i: number) => padX + (i * (width - padX * 2)) / (n - 1);
  const y = (value: number) => padTop + (1 - value / peak) * (height - padTop - padBottom);
  const line = values.map((value, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)} ${height - padBottom} L${x(0).toFixed(1)} ${height - padBottom} Z`;
  const total = values.reduce((sum, value) => sum + value, 0);

  return (
    <SpotlightCard as="section" className="ops-card" aria-label="访问趋势">
      <header><h2>访问趋势</h2></header>
      <div className="visit-trend">
        <div className="visit-trend-caption">
          <strong><CountUp to={points[n - 1].unique} /></strong>
          <span>今日独立访客 · 近 {n} 日累计 {total}</span>
        </div>
        <div className="visit-trend-chart">
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="近 7 日独立访客趋势">
            <defs>
              <linearGradient id="visit-trend-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--brand-from)" stopOpacity="0.28" />
                <stop offset="1" stopColor="var(--brand-from)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 1, 2].map((g) => {
              const gy = (padTop + (g * (height - padTop - padBottom)) / 2).toFixed(1);
              return <line key={g} x1="0" x2={width} y1={gy} y2={gy} stroke="var(--line-soft)" strokeWidth="1" />;
            })}
            <path d={area} fill="url(#visit-trend-fill)" />
            <path d={line} fill="none" stroke="var(--brand-from)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx={x(n - 1)} cy={y(values[n - 1])} r="3.5" fill="var(--brand-from)" />
            {points.map((point, i) => (
              <circle key={point.date} cx={x(i)} cy={y(point.unique)} r="9" fill="transparent">
                <title>{point.date}：独立 {point.unique} · 访问 {point.count}</title>
              </circle>
            ))}
          </svg>
        </div>
        <div className="visit-trend-x">
          {points.map((point) => <span key={point.date}>{point.date.slice(5)}</span>)}
        </div>
      </div>
    </SpotlightCard>
  );
}

const HEALTH_SEGMENTS: Array<{ key: Group["health_status"]; label: string; color: string }> = [
  { key: "healthy", label: "正常", color: "var(--ok)" },
  { key: "stale", label: "延迟", color: "var(--warn)" },
  { key: "error", label: "异常", color: "var(--danger)" },
  { key: "unknown", label: "未运行", color: "var(--soft-foreground)" }
];

/** A donut of the sources' health mix, drawn from the live source list (no extra request). */
function SourceHealthSummary({ groups }: { groups: Group[] }) {
  if (!groups.length) return null;
  const total = groups.length;
  const counts = groups.reduce<Record<string, number>>((acc, group) => {
    acc[group.health_status] = (acc[group.health_status] || 0) + 1;
    return acc;
  }, {});
  const segments = HEALTH_SEGMENTS
    .map((segment) => ({ ...segment, value: counts[segment.key] || 0 }))
    .filter((segment) => segment.value > 0);

  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const gap = segments.length > 1 ? 6 : 0;
  let offset = 0;

  return (
    <div className="source-health">
      <div className="source-health-donut">
        <svg viewBox="0 0 132 132" role="img" aria-label="来源健康分布">
          <circle cx="66" cy="66" r={radius} fill="none" stroke="var(--surface-muted)" strokeWidth="14" />
          {segments.map((segment) => {
            const length = (segment.value / total) * circumference;
            const draw = Math.max(0, length - gap);
            const ring = (
              <circle
                key={segment.key}
                cx="66"
                cy="66"
                r={radius}
                fill="none"
                stroke={segment.color}
                strokeWidth="14"
                strokeDasharray={`${draw} ${circumference - draw}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 66 66)"
              >
                <title>{segment.label}：{segment.value}</title>
              </circle>
            );
            offset += length;
            return ring;
          })}
        </svg>
        <div className="source-health-center"><strong>{total}</strong><span>来源</span></div>
      </div>
      <ul className="source-health-legend">
        {segments.map((segment) => (
          <li key={segment.key}>
            <span className="sw" style={{ background: segment.color }} aria-hidden="true" />
            <span>{segment.label}</span>
            <b>{segment.value}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
