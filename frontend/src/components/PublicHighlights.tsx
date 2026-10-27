import type { Message } from "../types";

type Period = "daily" | "weekly";

export function selectHighlights(messages: Message[], period: Period, now = new Date()): Message[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "weekly") start.setDate(start.getDate() - 6);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return messages
    .filter((message) => {
      const date = new Date(message.message_time);
      return !Number.isNaN(date.getTime()) && date >= start && date <= end;
    })
    .sort((a, b) => new Date(b.message_time).getTime() - new Date(a.message_time).getTime());
}

export default function PublicHighlights({ messages, period = "daily", now = new Date() }: { messages: Message[]; period?: Period; now?: Date }) {
  const items = selectHighlights(messages, period, now);
  const formatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  return (
    <section aria-labelledby="public-highlights-title" className="public-highlights">
      <p className="section-kicker">公开消息精选</p>
      <h2 id="public-highlights-title">{period === "daily" ? "今日精选" : "本周精选"}</h2>
      {items.length === 0 ? <p>该时间范围暂无公开消息。</p> : (
        <ol>
          {items.map((item) => <li key={item.id}>
            <p>{item.content || "（无文字内容）"}</p>
            <small>{item.chat_title} · {item.sender_name} · {formatter.format(new Date(item.message_time))}</small>
            <a href={item.source_url} target="_blank" rel="noreferrer">查看原消息</a>
          </li>)}
        </ol>
      )}
    </section>
  );
}
