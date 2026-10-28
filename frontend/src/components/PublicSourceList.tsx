import { Layers, Radio } from "lucide-react";
import type { PublicSource } from "../types";
import { sourceHue } from "../utils";

type PublicSourceListProps = {
  activeChatId: string;
  sources: PublicSource[];
  onSelect: (chatId: string) => void;
};

const healthClasses: Record<string, string> = {
  healthy: "is-healthy",
  stale: "is-stale",
  error: "is-error",
  unhealthy: "is-error"
};

function healthTitle(status: string | null | undefined) {
  if (status === "healthy") return "采集正常";
  if (status === "stale") return "采集延迟";
  if (status === "error" || status === "unhealthy") return "采集异常";
  return "采集等待中";
}

export default function PublicSourceList({ activeChatId, sources, onSelect }: PublicSourceListProps) {
  const totalMessages = sources.reduce((sum, source) => sum + (source.message_count || 0), 0);

  return (
    <aside className="pub-rail" aria-label="公开来源">
      <div className="pub-rail-head">
        <h2 className="pub-rail-title">
          <Layers size={14} aria-hidden="true" />
          资讯来源
        </h2>
        <span className="pub-rail-count">{sources.length}</span>
      </div>

      <ul className="pub-rail-list" role="radiogroup" aria-label="选择资讯来源">
        <li>
          <button
            type="button"
            role="radio"
            aria-checked={activeChatId === "all"}
            aria-label="全部公开来源"
            className="pub-source"
            onClick={() => onSelect("all")}
          >
            <span className="pub-source-mark" aria-hidden="true">
              <Radio size={15} />
            </span>
            <span className="pub-source-copy">
              <span className="pub-source-name">全部公开来源</span>
              <span className="pub-source-meta">聚合时间线 · {totalMessages.toLocaleString("zh-CN")} 条</span>
            </span>
            <span className="pub-source-state is-healthy" aria-hidden="true" />
          </button>
        </li>

        {sources.map((source) => {
          const isSelected = activeChatId === String(source.chat_id);
          const hue = sourceHue(`${source.chat_id ?? source.name}`);
          return (
            <li key={source.chat_id}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={source.name}
                className="pub-source"
                onClick={() => onSelect(String(source.chat_id))}
              >
                <span
                  className="pub-source-mark"
                  aria-hidden="true"
                  style={
                    isSelected
                      ? {
                          background: `linear-gradient(140deg, hsl(${hue} 62% 48%), hsl(${hue + 40} 58% 34%))`,
                          color: "#fff",
                        }
                      : undefined
                  }
                >
                  {source.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="pub-source-copy">
                  <span className="pub-source-name" title={source.name}>{source.name}</span>
                  <span className="pub-source-meta">{source.message_count.toLocaleString("zh-CN")} 条</span>
                </span>
                <span
                  className={`pub-source-state ${healthClasses[source.health_status || ""] || ""}`}
                  title={healthTitle(source.health_status)}
                  aria-hidden="true"
                />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="pub-rail-foot">公开频道内容自动聚合，按发布时间倒序排列。</div>
    </aside>
  );
}
