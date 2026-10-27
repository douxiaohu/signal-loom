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
      <div className="public-source-heading flex items-center justify-between px-2 text-xs font-medium text-zinc-400">
        <span className="flex items-center gap-1.5 uppercase tracking-wider">
          <Layers size={14} className="text-zinc-500" />
          <span>聚合频道</span>
        </span>
        <span className="px-2 py-0.5 rounded-full bg-white/5 text-[11px] font-mono text-zinc-500">
          {sources.length}
        </span>
      </div>

      <div className="public-source-list space-y-1.5">
        {/* 全部公开来源 */}
        <label
          className={`public-source-option w-full text-left p-3 rounded-xl border transition-all duration-200 cursor-pointer flex items-center justify-between group ${
            activeChatId === "all"
              ? "selected bg-zinc-800/80 border-white/20 shadow-md text-white"
              : "bg-zinc-900/40 hover:bg-zinc-900/70 border-white/5 hover:border-white/10 text-zinc-300"
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
              activeChatId === "all" ? "bg-white text-black" : "bg-white/10 text-zinc-300 group-hover:bg-white/20"
            }`}>
              <Radio size={15} />
            </div>
            <div className="public-source-copy min-w-0">
              <strong className="block text-sm font-medium truncate">全部公开来源</strong>
              <small className="block text-[11px] text-zinc-500 truncate">聚合时间线</small>
            </div>
          </div>
          {activeChatId === "all" && (
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
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
              className={`public-source-option w-full text-left p-3 rounded-xl border transition-all duration-200 cursor-pointer flex items-center justify-between group ${
                isSelected
                  ? "selected bg-zinc-800/80 border-white/20 shadow-md text-white"
                  : "bg-zinc-900/40 hover:bg-zinc-900/70 border-white/5 hover:border-white/10 text-zinc-300"
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
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white shadow-inner shrink-0"
                  style={{
                    background: `linear-gradient(135deg, hsl(${hue} 70% 40%), hsl(${hue + 40} 75% 25%))`,
                  }}
                >
                  {source.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="public-source-copy min-w-0">
                  <strong className="block text-sm font-medium truncate group-hover:text-white transition-colors">
                    {source.name}
                  </strong>
                  <small className="block text-[11px] text-zinc-500 font-mono truncate">
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
                      : "bg-zinc-600"
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
