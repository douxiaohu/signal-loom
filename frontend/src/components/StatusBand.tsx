import { LogOut, Menu } from "lucide-react";

import type { HealthStatus } from "../types";
import { ThemeSwitcher } from "../theme";
import { formatCount } from "../utils";

type StatusBandProps = {
  health: HealthStatus;
  healthyCount: number;
  messageCount: number;
  sourceCount: number;
  onLogout: () => void;
  onOpenFilters: () => void;
};

export default function StatusBand({ health, healthyCount, messageCount, sourceCount, onLogout, onOpenFilters }: StatusBandProps) {
  return (
    <header className="status-band">
      <div className="brand-lockup">
        <button className="icon-button mobile-filter-button" type="button" onClick={onOpenFilters} aria-label="打开筛选">
          <Menu size={18} aria-hidden="true" />
        </button>
        <span className={`status-dot is-${health}`} role="img" aria-label={`来源总体状态：${healthLabel(health)}`} />
        <div>
          <p>工作台</p>
          <h1>管理中心</h1>
        </div>
      </div>
      <dl className="status-metrics">
        <div><dt>来源</dt><dd>{formatCount(sourceCount)}</dd></div>
        <div><dt>本页消息</dt><dd>{formatCount(messageCount)}</dd></div>
        <div><dt>健康来源</dt><dd>{formatCount(healthyCount)}</dd></div>
      </dl>
      <div className="status-actions">
        <ThemeSwitcher />
        <button className="logout-button" type="button" onClick={onLogout}>
          <LogOut size={16} aria-hidden="true" /> 退出
        </button>
      </div>
    </header>
  );
}

function healthLabel(status: HealthStatus) {
  return { healthy: "正常", stale: "延迟", error: "异常", unknown: "未知" }[status];
}
