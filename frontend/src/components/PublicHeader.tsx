import { Search } from "lucide-react";
import { ThemeSwitcher } from "../theme";


type PublicHeaderProps = {
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  query: string;
  onQueryChange: (value: string) => void;
};


export default function PublicHeader({ onSubmit, query, onQueryChange }: PublicHeaderProps) {
  return (
    <header className="public-header">
      <div className="public-brand">
        <h1>Telegram 频道资讯监测平台</h1>
        <p>公开频道内容聚合、检索与状态追踪</p>
      </div>
      <nav className="surface-switcher public-surface-switcher" aria-label="公开专区">
        <a className="active" href="/" aria-current="page">频道资讯</a>
        <a href="/github">GitHub 排行榜</a>
      </nav>
      <form className="public-search" role="search" onSubmit={onSubmit}>
        <Search size={18} aria-hidden="true" />
        <label className="sr-only" htmlFor="public-query">搜索消息关键词</label>
        <input
          id="public-query"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索消息关键词…"
        />
        <button type="submit">搜索</button>
      </form>
      <div className="header-actions">
        <a className="admin-entry" href="/admin">管理员入口</a>
        <ThemeSwitcher />
      </div>
    </header>
  );
}
