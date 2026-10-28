import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Inbox } from "lucide-react";

import type { Message } from "../types";
import ErrorBoundary from "./ErrorBoundary";
import ImageViewer from "./ImageViewer";
import MessageCard from "./feed/MessageCard";
import MessageSkeleton from "./feed/MessageSkeleton";
import { groupMessages } from "./feed/groupMessages";
import type { FeedDensity, OpenImage } from "./feed/types";

/** Stands in for a message that failed to render. */
const BrokenMessage = (
  <article className="pub-card message-card">
    <p className="pub-media-note message-text">这条消息无法显示</p>
  </article>
);

type MessageFeedProps = {
  density?: FeedDensity;
  hasMore: boolean;
  initialLoading: boolean;
  loadingMore: boolean;
  messages: Message[];
  onLoadMore: () => void;
  groupDuplicates?: boolean;
};

export default function MessageFeed({
  density = "reading",
  hasMore,
  initialLoading,
  loadingMore,
  messages,
  onLoadMore,
  groupDuplicates = false
}: MessageFeedProps) {
  const [openImage, setOpenImage] = useState<OpenImage | null>(null);
  const [expanded, setExpanded] = useState<number[]>([]);
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const entries = useMemo(() => groupMessages(messages, groupDuplicates), [messages, groupDuplicates]);

  const openViewer = useCallback((image: OpenImage, trigger: HTMLButtonElement | null) => {
    lastTriggerRef.current = trigger;
    setOpenImage(image);
  }, []);
  const closeViewer = useCallback(() => setOpenImage(null), []);

  return (
    <>
      <main id="message-list" className="pub-feed" aria-label="消息时间线" tabIndex={-1}>
        {initialLoading && !messages.length ? <MessageSkeleton /> : null}

        {entries.map((entry) =>
          entry.type === "day" ? (
            <div key={entry.key} className="pub-day">
              <span>{entry.label}</span>
            </div>
          ) : (
            <div key={entry.message.id} className="pub-feed-group">
              <ErrorBoundary fallback={BrokenMessage}>
                <MessageCard density={density} message={entry.message} onOpenImage={openViewer} />
              </ErrorBoundary>
              {entry.similar.length ? (
                <button
                  className="pub-similar"
                  type="button"
                  aria-expanded={expanded.includes(entry.message.id)}
                  aria-label={`${expanded.includes(entry.message.id) ? "隐藏" : "显示"} ${entry.similar.length} 条相似消息`}
                  onClick={() =>
                    setExpanded((ids) =>
                      ids.includes(entry.message.id)
                        ? ids.filter((id) => id !== entry.message.id)
                        : [...ids, entry.message.id]
                    )
                  }
                >
                  <span className="pub-similar-badge">{entry.similar.length}</span>
                  <span aria-hidden="true">{expanded.includes(entry.message.id) ? "隐藏重复来源" : "条相似消息"}</span>
                  {expanded.includes(entry.message.id)
                    ? <ChevronUp size={13} aria-hidden="true" />
                    : <ChevronDown size={13} aria-hidden="true" />}
                </button>
              ) : null}
              {expanded.includes(entry.message.id) ? (
                <div className="pub-similar-group">
                  {entry.similar.map((similar) => (
                    <ErrorBoundary key={similar.id} fallback={BrokenMessage}>
                      <MessageCard compact density={density} message={similar} onOpenImage={openViewer} />
                    </ErrorBoundary>
                  ))}
                </div>
              ) : null}
            </div>
          )
        )}

        {!initialLoading && hasMore ? (
          <div className="pub-more">
            <button type="button" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? "正在加载更多…" : "加载更多"}
            </button>
          </div>
        ) : !initialLoading && messages.length ? (
          <div className="pub-feed-end">已经到底了</div>
        ) : !initialLoading ? (
          <div className="pub-empty">
            <span className="pub-empty-icon" aria-hidden="true">
              <Inbox size={22} />
            </span>
            <strong>没有匹配的消息</strong>
            <span>试试其它来源、媒体类型或关键词。</span>
          </div>
        ) : null}
      </main>

      {openImage ? (
        <ImageViewer
          src={openImage.src}
          alt={openImage.alt}
          returnFocusRef={lastTriggerRef}
          onClose={closeViewer}
        />
      ) : null}
    </>
  );
}
