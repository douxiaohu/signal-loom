import { useState } from "react";
import { Eye, EyeOff, Pause, Play, Radar } from "lucide-react";

import SpotlightCard from "../../bits/SpotlightCard";
import { operationKey } from "../../hooks/useOperationsActions";
import type { Group, ManagedSource } from "../../types";
import { formatCount, formatDate } from "../../utils";
import SourceComposer from "./SourceComposer";

type Anomaly = "all" | "failures" | "volume";

type SourcePanelProps = {
  groups: ManagedSource[];
  isBusy: (key: string) => boolean;
  onCreateSource: (name: string, sourceUrl: string) => Promise<void>;
  onCrawlSource: (chatId: number) => Promise<void>;
  onPatchSource: (group: Group, payload: { enabled?: boolean; public_visible?: boolean }) => Promise<void>;
};

/** "来源管理": every source with its health, the actions on it and a form to add one. */
export default function SourcePanel({ groups, isBusy, onCreateSource, onCrawlSource, onPatchSource }: SourcePanelProps) {
  const [anomaly, setAnomaly] = useState<Anomaly>("all");
  const visibleGroups = groups.filter((group) => matchesAnomaly(group, anomaly));
  const unhealthy = visibleGroups.filter((group) => group.health_status !== "healthy");
  return (
    <SpotlightCard as="section" id="source-operations" className="ops-card" tabIndex={-1} aria-labelledby="source-operations-title">
      <header><div><p className="section-kicker">运行</p><h2 id="source-operations-title">来源管理</h2></div><strong className={unhealthy.length ? "count-warn" : "count-ok"}>{unhealthy.length ? formatCount(unhealthy.length) : "正常"}</strong></header>
      <label>异常筛选 <select aria-label="来源异常筛选" value={anomaly} onChange={(event) => setAnomaly(event.target.value as Anomaly)}><option value="all">全部来源</option><option value="failures">连续失败</option><option value="volume">无新增消息</option></select></label>
      {visibleGroups.length ? (
        <table className="source-table">
          <thead>
            <tr>
              <th>来源</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visibleGroups.map((group) => (
              <tr key={group.chat_id}>
                <td>
                  <strong>{group.name}</strong>
                  <small>{healthCopy(group)}{anomalyCopy(group)}</small>
                </td>
                <td>
                  <small>{group.enabled === false ? "已停用" : "采集中"} · {group.public_visible ? "公开" : "私有"}</small>
                </td>
                <td>
                  <div className="source-table-actions">
                    <button type="button" disabled={isBusy(operationKey.source(group.chat_id))} onClick={() => void onPatchSource(group, { public_visible: !group.public_visible })}>
                      {group.public_visible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}{group.public_visible ? "私有" : "公开"}
                    </button>
                    <button type="button" disabled={isBusy(operationKey.source(group.chat_id))} onClick={() => void onPatchSource(group, { enabled: group.enabled === false })}>
                      {group.enabled === false ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{group.enabled === false ? "启用" : "停用"}
                    </button>
                    <button type="button" disabled={group.enabled === false || isBusy(operationKey.crawl(group.chat_id))} aria-busy={isBusy(operationKey.crawl(group.chat_id))} onClick={() => void onCrawlSource(group.chat_id)}><Radar size={14} aria-hidden="true" />{isBusy(operationKey.crawl(group.chat_id)) ? "采集中…" : "采集"}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="empty-copy">暂无来源配置</p>}
      <SourceComposer onCreate={onCreateSource} />
    </SpotlightCard>
  );
}

/** Sources whose summary has not loaded yet are not flagged: nothing is known about them. */
function matchesAnomaly(group: ManagedSource, anomaly: Anomaly) {
  if (anomaly === "failures") return (group.consecutive_failures ?? 0) > 0;
  if (anomaly === "volume") return group.new_message_volume === 0;
  return true;
}

function anomalyCopy(group: ManagedSource) {
  const parts: string[] = [];
  if (group.consecutive_failures !== undefined) parts.push(`连续失败 ${group.consecutive_failures}`);
  if (group.new_message_volume !== undefined) parts.push(`新增 ${group.new_message_volume}`);
  return parts.map((part) => ` · ${part}`).join("");
}

function healthCopy(group: Group) {
  if (group.health_status === "error") return group.last_error || "最近运行失败";
  if (group.health_status === "stale") return `上次成功 ${group.last_success_at ? formatDate(group.last_success_at) : "未知"}`;
  if (group.health_status === "unknown") return "尚无运行记录";
  return `抓取 ${group.fetched_count} · 入库 ${group.saved_count}`;
}
