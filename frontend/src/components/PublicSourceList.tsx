import { Layers, Radio } from "lucide-react";
import type { PublicSource } from "../types";
import { sourceHue } from "../utils";

type PublicSourceListProps = {
  activeChatId: string;
  sources: PublicSource[];
  onSelect: (chatId: string) => void;
};

export default function PublicSourceList({ activeChatId, sources, onSelect }: PublicSourceListProps) {
  return (
    <aside className="public-source-panel w-full lg:w-72 shrink-0 space-y-3" aria-label="公开来源">
      <div className="public-source-heading flex items-center justify-between px-2 text-xs font-medium text-[var(--muted-foreground)]">
        <span className="flex items-center gap-1.5 uppercase tracking-wider">
          <Layers size={14} className="opacity-70" />
          <span>聚合频道</span>
        </span>
        <span className="px-2 py-0.5 rounded-full bg-[var(--surface-muted)] text-[11px] font-mono text-[var(--muted-foreground)]">
          {sources.length}
        </span>
      </div>

      <div className="public-source-list space-y-2">
        {/* 全部公开来源 */}
        <label
          className={`public-source-option w-full text-left p-3 rounded-xl border transition-all duration-200 cursor-pointer flex items-center justify-between group shadow-xs ${
            activeChatId === "all"
              ? "selected bg-[var(--surface-muted)] border-[var(--foreground)] text-[var(--foreground)] font-medium shadow-sm"
              : "bg-[var(--card)] hover:bg-[var(--surface-muted)] border-[var(--border)] text-[var(--foreground)]"
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
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold transition-colors ${
              activeChatId === "all"
                ? "bg-[var(--foreground)] text-[var(--background)]"
                : "bg-[var(--surface-muted)] text-[var(--foreground)] group-hover:bg-[var(--border)]"
            }`}>
              <Radio size={15} />
            </div>
            <div className="public-source-copy min-w-0">
              <strong className="block text-sm font-medium truncate">全部公开来源</strong>
              <small className="block text-[11px] text-[var(--muted-foreground)] truncate">聚合时间线</small>
            </div>
          </div>
          {activeChatId === "all" && (
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
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
              className={`public-source-option w-full text-left p-3 rounded-xl border transition-all duration-200 cursor-pointer flex items-center justify-between group shadow-xs ${
                isSelected
                  ? "selected bg-[var(--surface-muted)] border-[var(--foreground)] text-[var(--foreground)] font-medium shadow-sm"
                  : "bg-[var(--card)] hover:bg-[var(--surface-muted)] border-[var(--border)] text-[var(--foreground)]"
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
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white shadow-xs shrink-0"
                  style={{
                    background: `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${hue + 40} 75% 35%))`,
                  }}
                >
                  {source.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="public-source-copy min-w-0">
                  <strong className="block text-sm font-medium truncate group-hover:text-[var(--foreground)] transition-colors">
                    {source.name}
                  </strong>
                  <small className="block text-[11px] text-[var(--muted-foreground)] font-mono truncate">
                    {source.message_count.toLocaleString("zh-CN")} 条
                  </small>
                </div>
              </div>

              {/* 状态指示器 */}
              <div className="flex items-center gap-2 shrink-0">
                <span
                  title={isHealthy ? "采集正常" : "采集等待中"}
                  className={`w-2 h-2 rounded-full ${
                    isHealthy
                      ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)] animate-pulse"
                      : "bg-[var(--muted-foreground)] opacity-50"
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
