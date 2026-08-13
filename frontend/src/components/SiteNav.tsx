type SiteNavProps = {
  current: "feed" | "github";
};

export default function SiteNav({ current }: SiteNavProps) {
  return (
    <nav className="site-nav" aria-label="公开专区">
      <a className={current === "feed" ? "active" : ""} href="/" aria-current={current === "feed" ? "page" : undefined}>频道资讯</a>
      <a className={current === "github" ? "active" : ""} href="/github" aria-current={current === "github" ? "page" : undefined}>GitHub 趋势</a>
    </nav>
  );
}
