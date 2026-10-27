import { Newspaper } from "lucide-react";

import ShinyText from "../bits/ShinyText";
import { ThemeSwitcher } from "../theme";

type PublicShellProps = {
  current: "feed";
  children: React.ReactNode;
};

const items = [
  { id: "feed", href: "/", label: "频道资讯", icon: Newspaper }
] as const;

export default function PublicShell({ current, children }: PublicShellProps) {
  return (
    <div className="public-app">
      <aside className="admin-sidebar">
        <a className="admin-brand" href="/" aria-label="回到首页">
          <img className="brand-mark" src="/favicon.svg" alt="" width="28" height="28" />
          <span>
            <strong><ShinyText text="频道资讯" /></strong>
            <small>公开阅读</small>
          </span>
        </a>
        <nav className="admin-menu" aria-label="公开专区">
          {items.map((item) => {
            const Icon = item.icon;
            const active = current === item.id;
            return (
              <a key={item.id} href={item.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
                <Icon size={16} aria-hidden="true" />
                {item.label}
              </a>
            );
          })}
        </nav>
        <div className="admin-footer">
          <ThemeSwitcher />
        </div>
      </aside>
      <div className="admin-content">{children}</div>
    </div>
  );
}
