import { useMemo } from "react";

import type { Message, PublicSource } from "../types";
import { formatCount, formatRelativeTime } from "../utils";

type ChannelPulseProps = {
  sources: PublicSource[];
  messages: Message[];
  loading: boolean;
};

/** How many hourly buckets the activity strip shows at most. */
const MAX_BARS = 24;

/** Buckets the loaded messages by clock-hour so the strip reflects real cadence, never invented figures. */
function hourlyCounts(messages: Message[]): number[] {
  const hours = messages
    .map((message) => new Date(message.message_time).getTime())
    .filter((time) => !Number.isNaN(time))
    .map((time) => Math.floor(time / 3_600_000));
  if (hours.length < 2) return [];

  const maxHour = Math.max(...hours);
  const minHour = Math.min(...hours);
  const span = Math.min(MAX_BARS, maxHour - minHour + 1);
  const startHour = maxHour - span + 1;

  const buckets = new Array<number>(span).fill(0);
  for (const hour of hours) {
    const index = hour - startHour;
    if (index >= 0 && index < span) buckets[index] += 1;
  }
  return buckets;
}

function newestTime(sources: PublicSource[], messages: Message[]): string | null {
  const times = [
    ...sources.map((source) => source.last_message_time),
    ...messages.map((message) => message.message_time)
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((time) => !Number.isNaN(time));
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

/**
 * A slim "heartbeat" ribbon above the timeline. Every figure is derived from data the
 * public API already returns — source counts, aggregate volume, last activity — and the
 * activity strip buckets the messages actually loaded, so nothing here is fabricated.
 */
export default function ChannelPulse({ sources, messages, loading }: ChannelPulseProps) {
  const sourceCount = sources.length;
  const healthyCount = sources.filter((source) => source.health_status === "healthy").length;
  const totalMessages = sources.reduce((sum, source) => sum + (source.message_count || 0), 0);
  const lastUpdate = useMemo(() => newestTime(sources, messages), [sources, messages]);

  const spark = useMemo(() => {
    const counts = hourlyCounts(messages);
    if (counts.length < 2) return null;
    const max = Math.max(...counts, 1);
    const width = 156;
    const height = 40;
    const gap = counts.length > 18 ? 2 : 3;
    const barWidth = (width - gap * (counts.length - 1)) / counts.length;
    const bars = counts.map((count, index) => {
      const barHeight = Math.max(2, (count / max) * (height - 4));
      return {
        x: index * (barWidth + gap),
        y: height - barHeight,
        width: barWidth,
        height: barHeight,
        last: index === counts.length - 1
      };
    });
    return { bars, hours: counts.length, width, height };
  }, [messages]);

  const sub = sourceCount > 0
    ? `正在聚合 ${sourceCount} 个公开频道 · 实时刷新`
    : loading
      ? "正在接入公开频道…"
      : "暂无公开频道";

  return (
    <section className="pub-pulse" aria-label="聚合概览">
      <div className="pub-pulse-lead">
        <span className="pub-pulse-eyebrow"><i aria-hidden="true" />实时聚合</span>
        <h2 className="pub-pulse-title">频道脉搏</h2>
        <p className="pub-pulse-sub">{sub}</p>
      </div>

      <dl className="pub-pulse-stats">
        <div className="pub-pulse-stat">
          <dt>公开来源</dt>
          <dd>
            {sourceCount > 0 ? sourceCount : "—"}
            {healthyCount > 0 ? <em>{healthyCount} 正常</em> : null}
          </dd>
        </div>
        <div className="pub-pulse-stat">
          <dt>聚合总量</dt>
          <dd>{totalMessages > 0 ? formatCount(totalMessages) : "—"}</dd>
        </div>
        <div className="pub-pulse-stat">
          <dt>最近更新</dt>
          <dd>{formatRelativeTime(lastUpdate)}</dd>
        </div>
      </dl>

      {spark ? (
        <div className="pub-pulse-spark">
          <div className="pub-pulse-spark-head">
            <span>消息节奏</span>
            <span>最近 {spark.hours} 小时</span>
          </div>
          <svg viewBox={`0 0 ${spark.width} ${spark.height}`} role="img" aria-label={`最近 ${spark.hours} 小时的消息节奏`}>
            {spark.bars.map((bar, index) => (
              <rect
                key={index}
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
                rx={Math.min(2, bar.width / 2)}
                fill="var(--link)"
                opacity={bar.last ? 1 : 0.5}
              />
            ))}
          </svg>
        </div>
      ) : null}
    </section>
  );
}
