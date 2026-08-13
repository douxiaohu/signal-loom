import { FormEvent, useState } from "react";
import { Check, Eye, EyeOff, Pause, Play, Radar, ShieldAlert } from "lucide-react";

import type { AlertMatch, AlertRule, Group } from "../types";
import { formatCount, formatDate } from "../utils";

type OperationsRailProps = {
  alerts: AlertMatch[];
  groups: Group[];
  rules: AlertRule[];
  onAcknowledge: (id: number) => Promise<void>;
  onCreateRule: (name: string, keyword: string) => Promise<void>;
  onCreateSource: (name: string, sourceUrl: string) => Promise<void>;
  onCrawlSource: (chatId: number) => Promise<void>;
  onPatchSource: (group: Group, payload: { enabled?: boolean; public_visible?: boolean }) => Promise<void>;
  onResolve: (id: number) => Promise<void>;
  onToggleRule: (rule: AlertRule) => Promise<void>;
};

export default function OperationsRail(props: OperationsRailProps) {
  const unhealthy = props.groups.filter((group) => group.health_status !== "healthy");
  const newAlerts = props.alerts.filter((alert) => alert.status === "new");
  return (
    <aside className="operations-rail" aria-label="来源健康与监测规则">
      <section id="source-operations" className="ops-card" tabIndex={-1} aria-labelledby="source-operations-title">
        <header><div><p className="section-kicker">SOURCE OPERATIONS</p><h2 id="source-operations-title">来源管理</h2></div><strong className={unhealthy.length ? "count-warn" : "count-ok"}>{unhealthy.length ? formatCount(unhealthy.length) : "OK"}</strong></header>
        <div className="health-list">
          {props.groups.map((group) => (
            <article className="source-admin-row" key={group.chat_id}>
              <div className="health-row">
                <span className={`health-dot health-${group.health_status}`} aria-hidden="true" />
                <span><strong>{group.name}</strong><small>{healthCopy(group)}</small></span>
              </div>
              <div className="source-badges" aria-label={`${group.name}的来源状态`}>
                <span>{group.enabled === false ? "已停用" : "采集中"}</span>
                <span>{group.public_visible ? "公开展示" : "仅管理员"}</span>
              </div>
              <div className="inline-actions source-actions">
                <button type="button" onClick={() => void props.onPatchSource(group, { public_visible: !group.public_visible })}>
                  {group.public_visible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}{group.public_visible ? "设为私有" : "设为公开"}
                </button>
                <button type="button" onClick={() => void props.onPatchSource(group, { enabled: group.enabled === false })}>
                  {group.enabled === false ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{group.enabled === false ? "启用采集" : "停用采集"}
                </button>
                <button type="button" disabled={group.enabled === false} onClick={() => void props.onCrawlSource(group.chat_id)}><Radar size={14} aria-hidden="true" />立即采集</button>
              </div>
            </article>
          ))}
          {!props.groups.length ? <p className="empty-copy">暂无来源配置</p> : null}
        </div>
        <SourceComposer onCreate={props.onCreateSource} />
      </section>
      <section id="alert-operations" className="ops-card" tabIndex={-1} aria-labelledby="alert-operations-title">
        <header><div><p className="section-kicker">RULE MATCHES</p><h2 id="alert-operations-title">规则命中</h2></div><strong className={newAlerts.length ? "count-warn" : "count-ok"}>{formatCount(newAlerts.length)}</strong></header>
        <div className="compact-list">
          {props.alerts.slice(0, 4).map((alert) => (
            <article className="compact-item" key={alert.id}>
              <div className="compact-title"><ShieldAlert size={16} aria-hidden="true" /><strong>{alert.rule_name}</strong><span className={`state state-${alert.status}`}>{alertStatus(alert.status)}</span></div>
              <p>{alert.content || `[${alert.media_type || "消息"}]`}</p>
              <small>{alert.chat_title} · {formatDate(alert.message_time)}</small>
              {alert.status !== "resolved" ? <div className="inline-actions">
                {alert.status === "new" ? <button type="button" onClick={() => void props.onAcknowledge(alert.id)}><Check size={14} aria-hidden="true" />确认</button> : null}
                <button type="button" onClick={() => void props.onResolve(alert.id)}>解决</button>
              </div> : null}
            </article>
          ))}
          {!props.alerts.length ? <p className="empty-copy">暂无规则命中</p> : null}
        </div>
        <RuleComposer rules={props.rules} onCreate={props.onCreateRule} onToggle={props.onToggleRule} />
      </section>
    </aside>
  );
}

function SourceComposer({ onCreate }: { onCreate: (name: string, sourceUrl: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onCreate(name, sourceUrl);
      setName("");
      setSourceUrl("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "来源创建失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rule-composer source-composer">
      <summary>添加公开 Telegram 频道</summary>
      <form onSubmit={submit}>
        <label htmlFor="source-name">来源名称</label><input id="source-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoComplete="off" />
        <label htmlFor="source-url">频道链接</label><input id="source-url" type="url" placeholder="https://t.me/channel" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} required maxLength={300} autoComplete="url" />
        {error ? <p className="form-error">{error}</p> : null}
        <button type="submit" disabled={busy}>{busy ? "正在添加…" : "添加来源（默认不公开）"}</button>
      </form>
    </details>
  );
}

function RuleComposer({ rules, onCreate, onToggle }: { rules: AlertRule[]; onCreate: (name: string, keyword: string) => Promise<void>; onToggle: (rule: AlertRule) => Promise<void> }) {
  const [name, setName] = useState("");
  const [keyword, setKeyword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onCreate(name, keyword);
      setName("");
      setKeyword("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "规则创建失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rule-composer">
      <summary>管理监测规则</summary>
      <div className="rule-list">
        {rules.map((rule) => <div key={rule.id}><span><strong>{rule.name}</strong><small>关键词：{rule.keyword}</small></span><button type="button" onClick={() => void onToggle(rule)}>{rule.enabled ? "停用" : "启用"}</button></div>)}
      </div>
      <form onSubmit={submit}>
        <label htmlFor="rule-name">规则名称</label><input id="rule-name" name="name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoComplete="off" />
        <label htmlFor="rule-keyword">普通关键词</label><input id="rule-keyword" name="keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} required maxLength={200} autoComplete="off" />
        {error ? <p className="form-error">{error}</p> : null}
        <button type="submit" disabled={busy}>{busy ? "正在创建…" : "创建为停用规则"}</button>
      </form>
    </details>
  );
}

function healthCopy(group: Group) {
  if (group.health_status === "error") return group.last_error || "最近运行失败";
  if (group.health_status === "stale") return `上次成功 ${group.last_success_at ? formatDate(group.last_success_at) : "未知"}`;
  if (group.health_status === "unknown") return "尚无运行记录";
  return `抓取 ${group.fetched_count} · 入库 ${group.saved_count}`;
}

function alertStatus(status: AlertMatch["status"]) { return { new: "新命中", acknowledged: "已确认", resolved: "已解决" }[status]; }
