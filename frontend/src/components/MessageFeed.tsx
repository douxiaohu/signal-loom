import { useRef, useState } from "react";
import { Download, ExternalLink, FileText, ImageOff, Inbox, Play, Volume2 } from "lucide-react";

import type { MediaItem, Message } from "../types";
import { cleanMessageContent, dayKey, formatDayLabel, formatTime, mediaLabel, sourceHue } from "../utils";
import ImageViewer from "./ImageViewer";

type FeedDensity = "reading" | "console";

type MessageFeedProps = {
  density?: FeedDensity;
  hasMore: boolean;
  initialLoading: boolean;
  loadingMore: boolean;
  messages: Message[];
  onLoadMore: () => void;
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
  onLoadMore
}: MessageFeedProps) {
  const [openImage, setOpenImage] = useState<OpenImage | null>(null);
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const openViewer = (image: OpenImage, trigger: HTMLButtonElement | null) => {
    lastTriggerRef.current = trigger;
    setOpenImage(image);
  };

  return (
    <>
      <main id="message-list" className="message-list" aria-label="消息时间线" tabIndex={-1}>
        {initialLoading && !messages.length ? <MessageSkeleton /> : null}
        {groupedMessages(messages).map((entry) => (
          entry.type === "day" ? (
            <h3 className="day-label" key={entry.key}>{entry.label}</h3>
          ) : (
            <MessageCard key={entry.message.id} density={density} message={entry.message} onOpenImage={openViewer} />
          )
        ))}
        {!initialLoading && hasMore ? (
          <button className="load-more" type="button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "正在加载更多…" : "加载更多"}
          </button>
        ) : !initialLoading && messages.length ? (
          <div className="feed-end">已显示全部匹配消息</div>
        ) : !initialLoading ? (
          <div className="empty-state">
            <Inbox size={28} aria-hidden="true" />
            <strong>没有匹配消息</strong>
            <span>调整来源、媒体类型或关键词后再试。</span>
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
  onOpenImage
}: {
  density: FeedDensity;
  message: Message;
  onOpenImage: (image: OpenImage, trigger: HTMLButtonElement | null) => void;
}) {
  const mediaItems = normalizedMediaItems(message);
  const speaker = message.sender_name || "未知发送者";
  const source = message.chat_title || "未知来源";
  const titleId = `message-${message.id}-title`;
  const content = cleanMessageContent(message.content);
  const mediaCount = mediaItems.length >= 5 ? "many" : String(Math.max(mediaItems.length, 1));
  const markHue = sourceHue(`${message.chat_id ?? source}`);
  return (
    <article className={`message-card ${density === "console" ? "is-console" : "is-reading"}`} aria-labelledby={titleId}>
      <header className="message-byline">
        <div className="message-byline-main">
          <span
            className={`source-mark ${density === "reading" ? "is-reading-mark" : ""}`}
            style={density === "reading" ? { background: `color-mix(in srgb, hsl(${markHue} 70% 55%) 20%, var(--paper))` } : undefined}
            aria-hidden="true"
          >
            {source.slice(0, 1).toUpperCase()}
          </span>
          <h3 id={titleId}>{source}</h3>
          <time dateTime={message.message_time}>{formatTime(message.message_time)}</time>
          {speaker !== source ? <span className="byline-speaker">{speaker}</span> : null}
          {density === "console" && message.media_type ? <span className="media-badge">{mediaLabel(message.media_type)}</span> : null}
        </div>
        {message.source_url ? (
          <a className="source-link" href={message.source_url} target="_blank" rel="noopener noreferrer">
            原文 <ExternalLink size={14} aria-hidden="true" />
          </a>
        ) : null}
      </header>
      {content ? <p className="message-text">{content}</p> : <p className="message-text muted-copy">仅包含{mediaLabel(message.media_type || "text")}</p>}
      {mediaItems.length ? (
        <div className={`media-grid media-count-${mediaCount}`} data-count={mediaItems.length}>
          {mediaItems.map((item, mediaIndex) => (
            <div className="media-cell" key={`${item.url}-${mediaIndex}`}>
              <MediaAttachment item={item} message={message} index={mediaIndex} onOpenImage={onOpenImage} />
            </div>
          ))}
        </div>
      ) : null}
      {density === "console" ? <footer className="message-foot"><span>消息 #{message.message_id}</span></footer> : null}
    </article>
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
      <a className="media-fallback" href={fallbackUrl} target="_blank" rel="noopener noreferrer">
        <ImageOff size={20} aria-hidden="true" />
        <span>媒体加载失败，打开原文</span>
      </a>
    );
  }
  if (["audio", "voice"].includes(kind) || ["audio", "voice"].includes(type)) {
    return (
      <div className="audio-card">
        <Volume2 size={20} aria-hidden="true" />
        <audio className="audio-control" controls preload="metadata" aria-label={`${source}中的音频`} onError={() => setFailed(true)}>
          <source src={item.url} />
        </audio>
      </div>
    );
  }
  if (["document", "file"].includes(kind) || type === "document") {
    return (
      <a className="file-card" href={item.url} download aria-label="下载文件">
        <FileText size={22} aria-hidden="true" />
        <span><strong>附件文件</strong><small>通过受保护的媒体缓存下载</small></span>
        <span className="file-action"><Download size={16} aria-hidden="true" /> 下载文件</span>
      </a>
    );
  }
  if (["video", "animation"].includes(kind)) {
    return (
      <video className="media-video" controls preload="metadata" aria-label={`${source}中的视频`} onError={() => setFailed(true)}>
        <source src={item.url} />
      </video>
    );
  }
  if (type === "video" && item.role === "poster") {
    return (
      <a className="video-poster" href={fallbackUrl} target="_blank" rel="noopener noreferrer">
        <img className={loaded ? "is-loaded" : ""} src={item.url} alt={`${source}中${speaker}发布的视频封面`} width="800" height="450" loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
        <span className="play-mark" aria-hidden="true"><Play size={22} fill="currentColor" /></span>
        <span>打开原文播放</span>
      </a>
    );
  }
  return (
    <button
      ref={imageButtonRef}
      className="media-image-trigger"
      type="button"
      aria-label={`查看完整图片 ${index + 1}`}
      onClick={() => onOpenImage({
        src: item.original_url || item.url,
        alt: `${source}中${speaker}发布的完整图片 ${index + 1}`
      }, imageButtonRef.current)}
    >
      <img
        className={`media-image-contained${loaded ? " is-loaded" : ""}`}
        src={item.url}
        alt={`${source}中${speaker}发布的图片 ${index + 1}`}
        width="800"
        height="500"
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

function groupedMessages(messages: Message[]) {
  const entries: Array<{ type: "day"; key: string; label: string } | { type: "item"; message: Message }> = [];
  let lastKey = "";
  for (const message of messages) {
    const key = dayKey(message.message_time);
    if (key !== lastKey) {
      entries.push({ type: "day", key: `day-${key}`, label: formatDayLabel(message.message_time) });
      lastKey = key;
    }
    entries.push({ type: "item", message });
  }
  return entries;
}

function normalizedMediaItems(message: Message): MediaItem[] {
  if (message.media_items?.length) return message.media_items;
  return message.media_urls.map((url) => ({
    url,
    kind: message.media_type === "video" ? "image" : message.media_type || "file",
    role: message.media_type === "video" ? "poster" : "media"
  }));
}

function MessageSkeleton() {
  return (
    <div className="message-skeleton" aria-label="正在加载消息">
      <span /><span /><span />
    </div>
  );
}
