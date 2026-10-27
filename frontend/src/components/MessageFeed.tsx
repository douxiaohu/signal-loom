import { useRef, useState } from "react";
import { Download, ExternalLink, FileText, ImageOff, Inbox, Volume2, Link as LinkIcon, Check, Copy } from "lucide-react";

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
      <main id="message-list" className="message-list space-y-5" aria-label="消息时间线" tabIndex={-1}>
        {initialLoading && !messages.length ? <MessageSkeleton /> : null}

        {groupedMessages(messages, groupDuplicates).map((entry) => (
          entry.type === "day" ? (
            <div key={entry.key} className="sticky top-2 z-10 flex items-center justify-center py-2 pointer-events-none">
              <span className="px-4 py-1 text-[11px] font-semibold tracking-wider text-[var(--muted-foreground)] bg-[var(--card)]/90 border border-[var(--border)] rounded-full backdrop-blur-md shadow-xs uppercase">
                {entry.label}
              </span>
            </div>
          ) : (
            <div key={entry.message.id} className="space-y-2">
              <MessageCard density={density} message={entry.message} onOpenImage={openViewer} />
              {entry.similar.length ? (
                <button
                  className="similar-toggle text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] ml-4 py-1 px-2.5 rounded-lg hover:bg-[var(--surface-muted)] transition-colors cursor-pointer"
                  type="button"
                  aria-expanded={expanded.includes(entry.message.id)}
                  onClick={() => setExpanded((ids) => ids.includes(entry.message.id) ? ids.filter((id) => id !== entry.message.id) : [...ids, entry.message.id])}
                >
                  {expanded.includes(entry.message.id) ? "隐藏" : "显示"} {entry.similar.length} 条相似消息
                </button>
              ) : null}
              {expanded.includes(entry.message.id) ? (
                <div className="pl-4 sm:pl-6 border-l-2 border-[var(--border)] space-y-3 mt-2">
                  {entry.similar.map((similar) => (
                    <MessageCard key={similar.id} density={density} message={similar} onOpenImage={openViewer} />
                  ))}
                </div>
              ) : null}
            </div>
          )
        ))}

        {!initialLoading && hasMore ? (
          <div className="flex justify-center pt-4 pb-12">
            <button
              className="load-more px-7 py-2.5 text-xs font-medium text-[var(--foreground)] bg-[var(--card)] hover:bg-[var(--surface-muted)] border border-[var(--border)] rounded-full shadow-xs backdrop-blur transition-all duration-200 cursor-pointer disabled:opacity-50"
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "正在加载更多…" : "加载更多"}
            </button>
          </div>
        ) : !initialLoading && messages.length ? (
          <div className="feed-end text-center text-xs text-[var(--muted-foreground)] py-10 border-t border-[var(--border)]">
            已显示全部匹配消息
          </div>
        ) : !initialLoading ? (
          <div className="empty-state flex flex-col items-center justify-center p-14 text-center border border-dashed border-[var(--border)] rounded-2xl bg-[var(--card)]">
            <Inbox size={36} className="text-[var(--muted-foreground)] mb-3 opacity-60" aria-hidden="true" />
            <strong className="text-sm font-semibold text-[var(--foreground)]">没有匹配消息</strong>
            <span className="text-xs text-[var(--muted-foreground)] mt-1">调整来源、媒体类型或关键词后再试。</span>
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
      className="message-card group relative rounded-2xl border border-[var(--border)] bg-[var(--card)] hover:border-[var(--ring)]/50 p-5 sm:p-6 transition-all duration-200 shadow-[0_1px_3px_rgba(0,0,0,0.03),0_1px_2px_rgba(0,0,0,0.02)] hover:shadow-md"
      aria-labelledby={titleId}
    >
      {/* 头部元信息栏 */}
      <header className="message-byline flex items-center justify-between gap-3 mb-3.5 pb-2.5 border-b border-[var(--border)]/30">
        <div className="message-byline-main flex items-center gap-3 min-w-0">
          {/* iOS Squircle 风格头像 */}
          <div
            className="source-mark w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold text-white shadow-xs shrink-0 select-none"
            style={{
              background: `linear-gradient(135deg, hsl(${markHue} 70% 45%), hsl(${markHue + 40} 75% 35%))`,
            }}
            aria-hidden="true"
          >
            {source.slice(0, 1).toUpperCase()}
          </div>

          <div className="min-w-0 flex flex-col justify-center">
            <div className="flex items-center gap-1.5 min-w-0">
              <h3 id={titleId} className="text-[14.5px] font-semibold text-[var(--foreground)] truncate leading-tight">
                {source}
              </h3>
              {speaker !== source && (
                <span className="byline-speaker text-xs text-[var(--muted-foreground)] truncate">· {speaker}</span>
              )}
            </div>
            <time dateTime={message.message_time} className="text-[11.5px] text-[var(--muted-foreground)] font-mono mt-0.5">
              {formatTime(message.message_time)}
            </time>
          </div>
        </div>

        {/* 右上角快捷操作栏 */}
        <div className="flex items-center gap-1 text-[var(--muted-foreground)] opacity-70 group-hover:opacity-100 transition-opacity">
          {cleanedContent && (
            <button
              type="button"
              onClick={handleCopyText}
              title="复制正文"
              aria-label="复制正文内容"
              className="p-1.5 hover:text-[var(--foreground)] hover:bg-[var(--surface-muted)] rounded-lg transition-colors cursor-pointer"
            >
              {copiedText ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
            </button>
          )}

          {message.source_url && (
            <>
              <button
                type="button"
                onClick={handleCopyLink}
                title="复制 Telegram 原文链接"
                aria-label="复制 Telegram 原文链接"
                className="p-1.5 hover:text-[var(--foreground)] hover:bg-[var(--surface-muted)] rounded-lg transition-colors cursor-pointer"
              >
                {copiedLink ? <Check size={14} className="text-emerald-500" /> : <LinkIcon size={14} />}
              </button>

              <a
                href={message.source_url}
                target="_blank"
                rel="noopener noreferrer"
                title="跳转 Telegram 查看原文"
                className="source-link inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 hover:text-[var(--foreground)] hover:bg-[var(--surface-muted)] rounded-lg transition-colors ml-0.5"
              >
                <span>原文</span>
                <ExternalLink size={12} />
              </a>
            </>
          )}
        </div>
      </header>

      {/* 正文内容增强（超链接解析、段落分层、长文折叠） */}
      {cleanedContent ? (
        <RichContent content={cleanedContent} />
      ) : (
        <p className="message-text text-xs text-[var(--muted-foreground)] italic">仅包含{mediaLabel(message.media_type || "text")}</p>
      )}

      {/* 多媒体相册展示 */}
      {mediaItems.length ? (
        <div className="media-grid mt-4">
          <MediaGallery items={mediaItems} message={message} onOpenImage={onOpenImage} />
        </div>
      ) : null}

      {density === "console" ? (
        <footer className="message-foot mt-3.5 pt-2 border-t border-[var(--border)]/60 flex items-center justify-between text-[11px] text-[var(--muted-foreground)] font-mono">
          <span>消息 #{message.message_id}</span>
          {message.media_type && (
            <span className="media-badge px-2 py-0.5 rounded-md bg-[var(--surface-muted)] text-[var(--foreground)]">
              {mediaLabel(message.media_type)}
            </span>
          )}
        </footer>
      ) : null}
    </article>
  );
}

// 优化的相册画廊
function MediaGallery({
  items,
  message,
  onOpenImage,
}: {
  items: MediaItem[];
  message: Message;
  onOpenImage: (image: OpenImage, trigger: HTMLButtonElement | null) => void;
}) {
  const count = items.length;

  if (count === 1) {
    return (
      <div className="overflow-hidden rounded-xl border border-[var(--border)] shadow-xs max-h-[520px] flex justify-center bg-black/5 dark:bg-black/30">
        <MediaAttachment item={items[0]} message={message} index={0} onOpenImage={onOpenImage} />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 overflow-hidden rounded-xl">
      {items.map((item, idx) => (
        <div key={idx} className="aspect-[4/3] overflow-hidden rounded-lg border border-[var(--border)] shadow-2xs bg-black/5 dark:bg-black/30">
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
      <a className="media-fallback flex items-center gap-2 p-3.5 text-xs text-[var(--muted-foreground)] bg-[var(--surface-muted)] rounded-xl hover:text-[var(--foreground)]" href={fallbackUrl} target="_blank" rel="noopener noreferrer">
        <ImageOff size={16} aria-hidden="true" />
        <span>媒体加载失败，打开原文</span>
      </a>
    );
  }

  if (["audio", "voice"].includes(kind) || ["audio", "voice"].includes(type)) {
    return (
      <div className="audio-card flex items-center gap-2.5 p-3 bg-[var(--surface-muted)] rounded-xl border border-[var(--border)]">
        <Volume2 size={18} className="text-[var(--muted-foreground)]" aria-hidden="true" />
        <audio className="audio-control w-full h-8" controls preload="metadata" aria-label={`${source}中的音频`} onError={() => setFailed(true)}>
          <source src={item.url} />
        </audio>
      </div>
    );
  }

  if (["document", "file"].includes(kind) || type === "document") {
    return (
      <a
        className="file-card flex items-center justify-between p-3.5 bg-[var(--surface-muted)] hover:bg-[var(--accent)] rounded-xl border border-[var(--border)] text-[var(--foreground)] transition-colors group/file"
        href={item.url}
        download
        aria-label="下载文件"
      >
        <div className="flex items-center gap-3">
          <FileText size={22} className="text-blue-500" aria-hidden="true" />
          <div className="flex flex-col">
            <strong className="text-xs font-semibold">附件文件</strong>
            <small className="text-[11px] text-[var(--muted-foreground)]">通过受保护的媒体缓存下载</small>
          </div>
        </div>
        <span className="file-action inline-flex items-center gap-1 text-xs text-[var(--muted-foreground)] group-hover/file:text-[var(--foreground)] transition-colors">
          <Download size={14} aria-hidden="true" /> 下载文件
        </span>
      </a>
    );
  }

  if (["video", "animation"].includes(kind)) {
    return (
      <video
        className="media-video w-full h-full max-h-[520px] object-contain rounded-xl"
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
      className="media-image-trigger w-full h-full overflow-hidden flex items-center justify-center cursor-zoom-in border-0 p-0"
      type="button"
      aria-label={`查看完整图片 ${index + 1}`}
      onClick={() => onOpenImage({
        src: item.original_url || item.url,
        alt: `${source}中${speaker}发布的完整图片 ${index + 1}`
      }, imageButtonRef.current)}
    >
      <img
        className={`media-image-contained w-full h-full object-contain max-h-[500px] transition-opacity duration-300 ${loaded ? "opacity-100 is-loaded" : "opacity-0"}`}
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
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 space-y-3.5 animate-pulse">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[var(--surface-muted)]" />
            <div className="space-y-1.5">
              <div className="w-28 h-3.5 bg-[var(--surface-muted)] rounded-md" />
              <div className="w-16 h-2.5 bg-[var(--surface-muted)] rounded-md" />
            </div>
          </div>
          <div className="space-y-2 pt-1">
            <div className="w-full h-3 bg-[var(--surface-muted)] rounded" />
            <div className="w-4/5 h-3 bg-[var(--surface-muted)] rounded" />
          </div>
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
