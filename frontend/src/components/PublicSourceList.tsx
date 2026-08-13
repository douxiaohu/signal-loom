import type { PublicSource } from "../types";


type PublicSourceListProps = {
  activeChatId: string;
  sources: PublicSource[];
  onSelect: (chatId: string) => void;
};


export default function PublicSourceList({ activeChatId, sources, onSelect }: PublicSourceListProps) {
  return (
    <aside className="public-source-panel" aria-label="公开来源">
      <div className="public-source-heading">
        <h2>公开来源</h2>
        <span>{sources.length}</span>
      </div>
      <label className={`public-source-option ${activeChatId === "all" ? "selected" : ""}`}>
        <input
          type="radio"
          name="public-source"
          checked={activeChatId === "all"}
          onChange={() => onSelect("all")}
        />
        <span><strong>全部公开来源</strong><small>聚合时间线</small></span>
      </label>
      {sources.map((source) => (
        <label className={`public-source-option ${activeChatId === String(source.chat_id) ? "selected" : ""}`} key={source.chat_id}>
          <input
            type="radio"
            name="public-source"
            checked={activeChatId === String(source.chat_id)}
            onChange={() => onSelect(String(source.chat_id))}
          />
          <span className={`health-dot health-${source.health_status}`} aria-hidden="true" />
          <span><strong>{source.name}</strong><small>{source.message_count.toLocaleString("zh-CN")} 条消息</small></span>
        </label>
      ))}
    </aside>
  );
}
