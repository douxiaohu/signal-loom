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
        <h2>来源</h2>
        <span>{sources.length}</span>
      </div>
      <div className="public-source-list">
        <label className={`public-source-option${activeChatId === "all" ? " selected" : ""}`}>
          <input type="radio" name="public-source" checked={activeChatId === "all"} onChange={() => onSelect("all")} />
          <span className="public-source-copy">
            <strong>全部公开来源</strong>
            <small>聚合时间线</small>
          </span>
        </label>
        {sources.map((source) => (
          <label className={`public-source-option${activeChatId === String(source.chat_id) ? " selected" : ""}`} key={source.chat_id}>
            <input
              type="radio"
              name="public-source"
              checked={activeChatId === String(source.chat_id)}
              onChange={() => onSelect(String(source.chat_id))}
            />
            <span className="public-source-copy">
              <strong>{source.name}</strong>
              <small>{source.message_count.toLocaleString("zh-CN")} 条</small>
            </span>
          </label>
        ))}
      </div>
    </aside>
  );
}
