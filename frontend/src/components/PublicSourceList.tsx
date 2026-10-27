import { Layers, Radio, Sparkles } from "lucide-react";
import type { PublicSource } from "../types";
import { sourceHue } from "../utils";

type PublicSourceListProps = {
  activeChatId: string;
  sources: PublicSource[];
  onSelect: (chatId: string) => void;
};

export default function PublicSourceList({ activeChatId, sources, onSelect }: PublicSourceListProps) {
  return (
    <aside
      className="public-source-panel group/sidebar w-full lg:w-[76px] lg:hover:w-72 shrink-0 transition-all duration-300 ease-out z-20"
      aria-label="公开来源"
    >
      {/* 侧边栏头部 */}
      <div className="flex items-center justify-between px-3 py-2 text-xs font-medium text-[var(--muted-foreground)] mb-2">
        <span className="flex items-center gap-2 uppercase tracking-wider overflow-hidden">
          <Layers size={16} className="text-[var(--neon)] shrink-0 transition-transform group-hover/sidebar:rotate-12 duration-300" />
          <span className="lg:opacity-0 lg:group-hover/sidebar:opacity-100 transition-opacity duration-200 whitespace-nowrap font-semibold">
            资讯频道
          </span>
        </span>
        <span className="hidden lg:group-hover/sidebar:inline-flex px-2 py-0.5 rounded-full bg-[var(--surface-muted)] text-[11px] font-mono text-[var(--foreground)] border border-[var(--border)]">
          {sources.length}
        </span>
      </div>

      <div className="public-source-list space-y-2">
        {/* 全部公开来源 */}
        <label
          className={`public-source-option relative w-full text-left p-2.5 rounded-2xl border transition-all duration-200 cursor-pointer flex items-center gap-3 overflow-hidden ${
            activeChatId === "all"
              ? "selected bg-[var(--card)]/90 border-[var(--neon)] shadow-[0_0_15px_rgba(0,240,255,0.15)] text-[var(--foreground)] font-medium before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r before:bg-[var(--neon)] before:shadow-[0_0_10px_var(--neon)]"
              : "bg-[var(--card)]/50 hover:bg-[var(--surface-muted)]/80 border-[var(--border)] text-[var(--foreground)]/80 hover:text-[var(--foreground)] hover:border-[var(--border)]"
          }`}
        >
          <input
            type="radio"
            name="public-source"
            checked={activeChatId === "all"}
            onChange={() => onSelect("all")}
            className="sr-only"
            aria-label="全部公开来源"
          />
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center text-xs font-bold transition-all duration-200 shrink-0 ${
              activeChatId === "all"
                ? "bg-gradient-to-tr from-cyan-500 to-blue-600 text-black shadow-[0_0_12px_rgba(0,240,255,0.4)] scale-105"
                : "bg-[var(--surface-muted)] text-[var(--foreground)] hover:scale-105"
            }`}
          >
            <Radio size={16} />
          </div>
          <div className="public-source-copy min-w-0 flex-1 lg:opacity-0 lg:group-hover/sidebar:opacity-100 transition-opacity duration-200 whitespace-nowrap">
            <strong className="block text-sm font-medium truncate">全部公开来源</strong>
            <small className="block text-[11px] text-[var(--muted-foreground)] truncate font-mono">聚合时间线</small>
          </div>
          {activeChatId === "all" && (
            <div className="hidden lg:group-hover/sidebar:block w-2 h-2 rounded-full bg-[var(--neon)] shadow-[0_0_8px_var(--neon)] shrink-0 mr-1" />
          )}
        </label>

        {/* 各频道独立项 */}
        {sources.map((source) => {
          const isSelected = activeChatId === String(source.chat_id);
          const hue = sourceHue(`${source.chat_id ?? source.name}`);
          const isHealthy = source.health_status === "healthy";

          return (
            <label
              key={source.chat_id}
              className={`public-source-option relative w-full text-left p-2.5 rounded-2xl border transition-all duration-200 cursor-pointer flex items-center gap-3 overflow-hidden ${
                isSelected
                  ? "selected bg-[var(--card)]/90 border-[var(--neon)] shadow-[0_0_15px_rgba(0,240,255,0.15)] text-[var(--foreground)] font-medium before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r before:bg-[var(--neon)] before:shadow-[0_0_10px_var(--neon)]"
                  : "bg-[var(--card)]/50 hover:bg-[var(--surface-muted)]/80 border-[var(--border)] text-[var(--foreground)]/80 hover:text-[var(--foreground)] hover:border-[var(--border)]"
              }`}
            >
              <input
                type="radio"
                name="public-source"
                checked={isSelected}
                onChange={() => onSelect(String(source.chat_id))}
                className="sr-only"
                aria-label={source.name}
              />
              <div
                className={`w-10 h-10 rounded-xl flex items-center justify-center text-xs font-bold text-white shrink-0 transition-transform duration-200 select-none shadow-xs ${
                  isSelected ? "scale-105 ring-2 ring-[var(--neon)]/60 shadow-[0_0_12px_rgba(0,240,255,0.3)]" : "hover:scale-105"
                }`}
                style={{
                  background: `linear-gradient(135deg, hsl(${hue} 75% 50%), hsl(${hue + 45} 80% 38%))`,
                }}
              >
                {source.name.slice(0, 1).toUpperCase()}
              </div>

              <div className="public-source-copy min-w-0 flex-1 lg:opacity-0 lg:group-hover/sidebar:opacity-100 transition-opacity duration-200 whitespace-nowrap">
                <strong className="block text-sm font-medium truncate">
                  {source.name}
                </strong>
                <small className="block text-[11px] text-[var(--muted-foreground)] font-mono truncate">
                  {source.message_count.toLocaleString("zh-CN")} 条
                </small>
              </div>

              {/* 状态指示点 */}
              <div className="hidden lg:group-hover/sidebar:flex items-center gap-2 shrink-0 mr-1">
                <span
                  title={isHealthy ? "采集正常" : "采集等待中"}
                  className={`w-2 h-2 rounded-full ${
                    isHealthy
                      ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)] animate-pulse"
                      : "bg-[var(--muted-foreground)] opacity-40"
                  }`}
                />
              </div>
            </label>
          );
        })}
      </div>
    </aside>
  );
}
