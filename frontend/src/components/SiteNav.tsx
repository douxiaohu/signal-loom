import { Button } from "@/components/ui/button";

type SiteNavProps = {
  current: "feed";
};

const items = [
  { id: "feed", href: "/", label: "频道资讯" }
] as const;

export default function SiteNav({ current }: SiteNavProps) {
  return (
    <nav className="site-nav" aria-label="公开专区">
      {items.map((item) => {
        const active = current === item.id;
        return (
          <Button key={item.id} asChild variant={active ? "nav" : "ghost"} size="sm">
            <a href={item.href} aria-current={active ? "page" : undefined}>{item.label}</a>
          </Button>
        );
      })}
    </nav>
  );
}
