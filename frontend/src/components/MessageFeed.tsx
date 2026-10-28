import { useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  FileText,
  ImageOff,
  Inbox,
  Link as LinkIcon,
  Volume2
} from "lucide-react";

import type { MediaItem, Message } from "../types";
import { cleanMessageContent, dayKey, formatDayLabel, formatTime, mediaLabel, sourceHue } from "../utils";
import ImageViewer from "./ImageViewer";
import RichContent from "./RichContent";

type FeedDensity = "reading" | "console";

type MessageFeedProps = {
  density?: FeedDensity;
  hasMore: boolean;
  initialLoading: boolean;
  loadingMore: boolean;
  messages: Message[];
  onLoadMore: () => void;
  groupDuplicates?: boolean;
};

type OpenImage = {
  alt: string;
  src: string;
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

  const openViewer = (image: OpenImage, trigger: HTMLButtonElement | null) => {
    lastTriggerRef.current = trigger;
    setOpenImage(image);
  };

  return (
    <>
      <main id="message-list" className="pub-feed" aria-label="消息时间线" tabIndex={-1}>
        {initialLoading && !messages.length ? <MessageSkeleton /> : null}

        {groupedMessages(messages, groupDuplicates).map((entry) =>
          entry.type === "day" ? (
            <div key={entry.key} className="pub-day">
              <span>{entry.label}</span>
            </div>
          ) : (
            <div key={entry.message.id} className="pub-feed-group">
              <MessageCard density={density} message={entry.message} onOpenImage={openViewer} />
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
                    <MessageCard key={similar.id} compact density={density} message={similar} onOpenImage={openViewer} />
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
          onClose={() => setOpenImage(null)}
        />
      ) : null}
    </>
  );
}

export function MessageCard({
  density,
  message,
  onOpenImage,
  compact = false
}: {
  density: FeedDensity;
  message: Message;
  onOpenImage: (image: OpenImage, trigger: HTMLButtonElement | null) => void;
  compact?: boolean;
}) {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const mediaItems = normalizedMediaItems(message);
  const speaker = message.sender_name || "未知发送者";
  const source = message.chat_title || "未知来源";
  const titleId = `message-${message.id}-title`;
  const markHue = sourceHue(`${message.chat_id ?? source}`);
  const cleanedContent = cleanMessageContent(message.content);

  const handleCopyLink = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (message.source_url) {
      navigator.clipboard.writeText(message.source_url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  const handleCopyText = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (cleanedContent) {
      navigator.clipboard.writeText(cleanedContent);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2000);
    }
  };

  return (
    <article
      className={`pub-card message-card${density === "console" ? " is-console" : " is-reading"}${compact ? " is-nested" : ""}`}
      aria-labelledby={titleId}
    >
      <header className="pub-card-head">
        <div className="pub-source-id">
          <span
            className="pub-avatar source-mark"
            aria-hidden="true"
            style={{
              background: `linear-gradient(140deg, hsl(${markHue} 55% 46%), hsl(${markHue + 42} 58% 32%))`,
              color: "#fff"
            }}
          >
            {source.slice(0, 1).toUpperCase()}
          </span>

          <div className="pub-card-name">
            <h3 id={titleId} className="pub-card-source">{source}</h3>
            <div className="pub-card-sub">
              {speaker !== source && (
                <>
                  <span className="byline-speaker pub-sender">· {speaker}</span>
                  <span className="pub-sep" aria-hidden="true">/</span>
                </>
              )}
              <time dateTime={message.message_time} className="pub-card-time">
                {formatTime(message.message_time)}
              </time>
            </div>
          </div>
        </div>

        <div className="pub-card-actions">
          {cleanedContent && (
            <button
              type="button"
              onClick={handleCopyText}
              title="复制正文"
              aria-label="复制正文内容"
              className={copiedText ? "is-done" : undefined}
            >
              {copiedText ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}

          {message.source_url && (
            <>
              <button
                type="button"
                onClick={handleCopyLink}
                title="复制原文链接"
                aria-label="复制 Telegram 原文链接"
                className={copiedLink ? "is-done" : undefined}
              >
                {copiedLink ? <Check size={14} /> : <LinkIcon size={14} />}
              </button>

              <a
                href={message.source_url}
                target="_blank"
                rel="noopener noreferrer"
                title="在 Telegram 查看原文"
                className="source-link pub-card-action-wide"
              >
                <span>原文</span>
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            </>
          )}
        </div>
      </header>

      {cleanedContent ? (
        <RichContent content={cleanedContent} />
      ) : (
        <p className="pub-media-note message-text">仅包含{mediaLabel(message.media_type || "text")}</p>
      )}

      {mediaItems.length ? (
        <div className="pub-media media-grid">
          <MediaGallery items={mediaItems} message={message} onOpenImage={onOpenImage} />
        </div>
      ) : null}

      {density === "console" ? (
        <footer className="pub-card-foot message-foot">
          <span>消息 #{message.message_id}</span>
          {message.media_type && (
            <span className="media-badge">{mediaLabel(message.media_type)}</span>
          )}
        </footer>
      ) : null}
    </article>
  );
}

function MediaGallery({
  items,
  message,
  onOpenImage
}: {
  items: MediaItem[];
  message: Message;
  onOpenImage: (image: OpenImage, trigger: HTMLButtonElement | null) => void;
}) {
  const count = items.length;

  if (count === 1) {
    const only = items[0];
    const kind = only.kind.toLowerCase();
    const type = (message.media_type || kind).toLowerCase();
    const plain =
      ["audio", "voice", "document", "file"].includes(kind) ||
      ["audio", "voice", "document"].includes(type);
    return (
      <div className={`pub-media-single${plain ? " is-plain" : ""}`}>
        <div className="pub-media-cell">
          <MediaAttachment item={items[0]} message={message} index={0} onOpenImage={onOpenImage} />
        </div>
      </div>
    );
  }

  return (
    <div className={`pub-media-grid${count > 4 ? " is-many" : ""}`}>
      {items.map((item, idx) => (
        <div key={idx} className="pub-media-cell">
          <MediaAttachment item={item} message={message} index={idx} onOpenImage={onOpenImage} />
        </div>
      ))}
    </div>
  );
}

function MediaAttachment({
  item,
  message,
  index,
  onOpenImage
}: {
  item: MediaItem;
  message: Message;
  index: number;
  onOpenImage: (image: OpenImage, trigger: HTMLButtonElement | null) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imageButtonRef = useRef<HTMLButtonElement>(null);
  const source = message.chat_title || "未知来源";
  const speaker = message.sender_name || "未知发送者";
  const kind = item.kind.toLowerCase();
  const type = (message.media_type || kind).toLowerCase();
  const fallbackUrl = message.source_url || item.url;

  if (failed) {
    return (
      <a
        className="pub-attachment"
        href={fallbackUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="pub-attachment-icon" aria-hidden="true"><ImageOff size={17} /></span>
        <span className="pub-attachment-copy">
          <strong>媒体加载失败</strong>
          <small>点击打开原文查看</small>
        </span>
        <span className="pub-attachment-cta"><ExternalLink size={13} /></span>
      </a>
    );
  }

  if (["audio", "voice"].includes(kind) || ["audio", "voice"].includes(type)) {
    return (
      <div className="pub-audio">
        <Volume2 size={17} aria-hidden="true" />
        <audio
          className="audio-control"
          controls
          preload="metadata"
          aria-label={`${source}中的音频`}
          onError={() => setFailed(true)}
        >
          <source src={item.url} />
        </audio>
      </div>
    );
  }

  if (["document", "file"].includes(kind) || type === "document") {
    return (
      <a className="pub-attachment file-card" href={item.url} download aria-label="下载文件">
        <span className="pub-attachment-icon" aria-hidden="true"><FileText size={17} /></span>
        <span className="pub-attachment-copy">
          <strong>附件文件</strong>
          <small>点击下载</small>
        </span>
        <span className="pub-attachment-cta">
          <Download size={14} aria-hidden="true" /> <span>下载</span>
        </span>
      </a>
    );
  }

  if (["video", "animation"].includes(kind)) {
    return (
      <video
        className="pub-media-video"
        controls
        preload="metadata"
        aria-label={`${source}中的视频`}
        onError={() => setFailed(true)}
      >
        <source src={item.url} />
      </video>
    );
  }

  return (
    <button
      ref={imageButtonRef}
      className="pub-media-trigger"
      type="button"
      aria-label={`查看完整图片 ${index + 1}`}
      onClick={() =>
        onOpenImage(
          {
            src: item.original_url || item.url,
            alt: `${source}中${speaker}发布的完整图片 ${index + 1}`
          },
          imageButtonRef.current
        )
      }
    >
      {!loaded ? <span className="pub-media-loading" aria-hidden="true" /> : null}
      <img
        className={`pub-media-img media-image-contained${loaded ? " is-loaded" : ""}`}
        src={item.url}
        alt={`${source}中${speaker}发布的图片 ${index + 1}`}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

function MessageSkeleton() {
  return (
    <div className="pub-skeleton" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="pub-skeleton-card">
          <div className="pub-skeleton-head">
            <div className="pub-skeleton-line" style={{ width: 34, height: 34, borderRadius: 10 }} />
            <div style={{ flex: 1 }}>
              <div className="pub-skeleton-line" style={{ width: "32%", margin: 0 }} />
              <div className="pub-skeleton-line" style={{ width: "18%" }} />
            </div>
          </div>
          <div className="pub-skeleton-line" style={{ width: "94%" }} />
          <div className="pub-skeleton-line" style={{ width: "86%" }} />
          <div className="pub-skeleton-line" style={{ width: "62%" }} />
        </div>
      ))}
    </div>
  );
}

function normalizedMediaItems(message: Message): MediaItem[] {
  if (message.media_items && message.media_items.length) {
    return message.media_items;
  }
  if (message.media_urls && message.media_urls.length) {
    return message.media_urls.map((url) => ({
      url,
      kind: message.media_type || "image",
      role: "media",
    }));
  }
  return [];
}

type GroupedEntry =
  | { type: "day"; key: string; label: string }
  | { type: "message"; message: Message; similar: Message[] };

function groupedMessages(messages: Message[], groupDuplicates: boolean): GroupedEntry[] {
  const result: GroupedEntry[] = [];
  let currentDay = "";

  for (const m of messages) {
    const day = dayKey(m.message_time);
    if (day !== currentDay) {
      currentDay = day;
      result.push({
        type: "day",
        key: `day-${day}`,
        label: formatDayLabel(m.message_time),
      });
    }

    if (groupDuplicates && m.content && m.content.trim().length > 6) {
      const existing = result.find(
        (entry) =>
          entry.type === "message" &&
          cleanMessageContent(entry.message.content).trim() === cleanMessageContent(m.content).trim()
      );
      if (existing && existing.type === "message") {
        existing.similar.push(m);
        continue;
      }
    }

    result.push({
      type: "message",
      message: m,
      similar: [],
    });
  }
  return result;
}
