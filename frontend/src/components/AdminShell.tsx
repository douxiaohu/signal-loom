import { GitBranch, History, LayoutDashboard, RadioTower, Search, ShieldAlert } from "lucide-react";

import type { AdminView } from "../types";

const items: Array<{ id: AdminView; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "sources", label: "来源采集", icon: RadioTower },
  { id: "github", label: "GitHub / AI", icon: GitBranch },
  { id: "visits", label: "访问记录", icon: History },
  { id: "alerts", label: "规则命中", icon: ShieldAlert },
  { id: "messages", label: "消息检索", icon: Search }
];

type AdminShellProps = {
  view: AdminView;
  onChangeView: (view: AdminView) => void;
  onLogout: () => void;
  children: React.ReactNode;
};

export default function AdminShell({ view, onChangeView, onLogout, children }: AdminShellProps) {
  return (
    <div className="admin-app">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <strong>管理中心</strong>
          <small>后台工作台</small>
        </div>
        <nav className="admin-menu" aria-label="后台模块">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? "active" : ""}
                type="button"
                aria-current={view === item.id ? "page" : undefined}
                onClick={() => onChangeView(item.id)}
              >
                <Icon size={16} aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </nav>
        <button className="logout-button admin-logout" type="button" onClick={onLogout}>退出</button>
      </aside>
      <div className="admin-content">{children}</div>
    </div>
  );
}
