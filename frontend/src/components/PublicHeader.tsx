import ShinyText from "../bits/ShinyText";
import { ThemeSelect } from "../theme";
import SearchField from "./SearchField";
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
        <h1><ShinyText text="频道资讯" /></h1>
      </a>
      <SiteNav current="feed" />
      <SearchField
        id="public-query"
        label="搜索消息关键词"
        placeholder="搜索消息关键词…"
        value={query}
        onChange={onQueryChange}
        onSubmit={onSubmit}
      />
      <div className="header-actions">
        <ThemeSelect />
      </div>
    </header>
  );
}
