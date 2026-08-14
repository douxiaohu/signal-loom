import { Search } from "lucide-react";

import { ThemeSwitcher } from "../theme";
import SiteNav from "./SiteNav";

type PublicHeaderProps = {
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  query: string;
  onQueryChange: (value: string) => void;
};

export default function PublicHeader({ onSubmit, query, onQueryChange }: PublicHeaderProps) {
  return (
    <header className="site-header">
      <a className="site-brand" href="/" aria-label="频道资讯首页">
        <img className="brand-mark" src="/favicon.svg" alt="" width="28" height="28" />
        <h1>频道资讯</h1>
      </a>
      <SiteNav current="feed" />
      <form className="site-search" role="search" onSubmit={onSubmit}>
        <Search size={16} aria-hidden="true" />
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
        <ThemeSwitcher />
      </div>
    </header>
  );
}
