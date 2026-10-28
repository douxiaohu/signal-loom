import { Check, ShieldAlert } from "lucide-react";

import SpotlightCard from "../../bits/SpotlightCard";
import { operationKey } from "../../hooks/useOperationsActions";
import type { AlertMatch, AlertRule } from "../../types";
import { formatCount, formatDate } from "../../utils";
import RuleComposer from "./RuleComposer";

type AlertPanelProps = {
  alerts: AlertMatch[];
  rules: AlertRule[];
  /** The alerts page lists every match; the combined page only the latest eight. */
  showAll: boolean;
  isBusy: (key: string) => boolean;
  onAcknowledge: (id: number) => Promise<void>;
  onCreateRule: (name: string, keyword: string) => Promise<void>;
  onResolve: (id: number) => Promise<void>;
  onToggleRule: (rule: AlertRule) => Promise<void>;
};

/** "规则命中": the matches of the monitoring rules, with acknowledge / resolve, plus rule management. */
export default function AlertPanel({ alerts, rules, showAll, isBusy, onAcknowledge, onCreateRule, onResolve, onToggleRule }: AlertPanelProps) {
  const newAlerts = alerts.filter((alert) => alert.status === "new");
  return (
    <SpotlightCard as="section" id="alert-operations" className="ops-card" tabIndex={-1} aria-labelledby="alert-operations-title">
      <header><div><p className="section-kicker">监测</p><h2 id="alert-operations-title">规则命中</h2></div><strong className={newAlerts.length ? "count-warn" : "count-ok"}>{formatCount(newAlerts.length)}</strong></header>
      <div className="compact-list">
        {(showAll ? alerts : alerts.slice(0, 8)).map((alert) => (
          <article className="compact-item" key={alert.id}>
            <div className="compact-title"><ShieldAlert size={16} aria-hidden="true" /><strong>{alert.rule_name}</strong><span className={`state state-${alert.status}`}>{alertStatus(alert.status)}</span></div>
            <p>{alert.content || `[${alert.media_type || "消息"}]`}</p>
            <small>{alert.chat_title} · {formatDate(alert.message_time)}</small>
            {alert.status !== "resolved" ? <div className="inline-actions">
              {alert.status === "new" ? <button type="button" disabled={isBusy(operationKey.alert(alert.id))} onClick={() => void onAcknowledge(alert.id)}><Check size={14} aria-hidden="true" />确认</button> : null}
              <button type="button" disabled={isBusy(operationKey.alert(alert.id))} onClick={() => void onResolve(alert.id)}>解决</button>
            </div> : null}
          </article>
        ))}
        {!alerts.length ? <p className="empty-copy">暂无规则命中</p> : null}
      </div>
      <RuleComposer rules={rules} isBusy={isBusy} onCreate={onCreateRule} onToggle={onToggleRule} />
    </SpotlightCard>
  );
}

function alertStatus(status: AlertMatch["status"]) { return { new: "新命中", acknowledged: "已确认", resolved: "已解决" }[status]; }
