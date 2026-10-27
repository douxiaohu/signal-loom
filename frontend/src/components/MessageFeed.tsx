import { useRef, useState } from "react";
import { Download, ExternalLink, FileText, ImageOff, Inbox, Volume2, Link as LinkIcon, Check } from "lucide-react";

import type { MediaItem, Message } from "../types";
import { dayKey, formatDayLabel, formatTime, mediaLabel, sourceHue } from "../utils";
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
      <main id="message-list" className="message-list space-y-4" aria-label="消息时间线" tabIndex={-1}>
        {initialLoading && !messages.length ? <MessageSkeleton /> : null}

        {groupedMessages(messages, groupDuplicates).map((entry) => (
          entry.type === "day" ? (
            <div key={entry.key} className="sticky top-2 z-10 flex items-center justify-center py-2 pointer-events-none">
              <span className="px-3 py-1 text-[11px] font-semibold tracking-wider text-zinc-400 bg-zinc-900/90 border border-white/10 rounded-full backdrop-blur-md shadow-sm uppercase">
                {entry.label}
              </span>
            </div>
          ) : (
            <div key={entry.message.id} className="space-y-2">
              <MessageCard density={density} message={entry.message} onOpenImage={openViewer} />
              {entry.similar.length ? (
                <button
                  className="similar-toggle text-xs text-zinc-500 hover:text-zinc-300 ml-4 py-1 px-2 rounded hover:bg-white/5 transition-colors cursor-pointer"
                  type="button"
                  aria-expanded={expanded.includes(entry.message.id)}
                  onClick={() => setExpanded((ids) => ids.includes(entry.message.id) ? ids.filter((id) => id !== entry.message.id) : [...ids, entry.message.id])}
                >
                  {expanded.includes(entry.message.id) ? "隐藏" : "显示"} {entry.similar.length} 条相似消息
                </button>
              ) : null}
              {expanded.includes(entry.message.id) ? (
                <div className="pl-4 border-l border-white/10 space-y-2">
                  {entry.similar.map((similar) => (
                    <MessageCard key={similar.id} density={density} message={similar} onOpenImage={openViewer} />
                  ))}
                </div>
              ) : null}
            </div>
          )
        ))}

        {!initialLoading && hasMore ? (
          <div className="flex justify-center pt-4 pb-8">
            <button
              className="load-more px-6 py-2.5 text-xs font-medium text-zinc-300 hover:text-white bg-zinc-900/80 hover:bg-zinc-800 border border-white/10 hover:border-white/20 rounded-full shadow-lg backdrop-blur transition-all duration-200 cursor-pointer disabled:opacity-50"
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "正在加载更多…" : "加载更多"}
            </button>
          </div>
        ) : !initialLoading && messages.length ? (
          <div className="feed-end text-center text-xs text-zinc-500 py-8 border-t border-white/5">
            已显示全部匹配消息
          </div>
        ) : !initialLoading ? (
          <div className="empty-state flex flex-col items-center justify-center p-12 text-center border border-dashed border-white/10 rounded-2xl bg-zinc-950/40">
            <Inbox size={32} className="text-zinc-600 mb-3" aria-hidden="true" />
            <strong className="text-sm text-zinc-300">没有匹配消息</strong>
            <span className="text-xs text-zinc-500 mt-1">调整来源、媒体类型或关键词后再试。</span>
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
  const mediaItems = normalizedMediaItems(message);
  const speaker = message.sender_name || "未知发送者";
  const source = message.chat_title || "未知来源";
  const titleId = `message-${message.id}-title`;
  const markHue = sourceHue(`${message.chat_id ?? source}`);

  const handleCopyLink = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (message.source_url) {
      navigator.clipboard.writeText(message.source_url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  return (
    <article
      className="message-card group relative rounded-xl border border-white/[0.08] hover:border-white/[0.18] bg-zinc-900/50 hover:bg-zinc-900/70 backdrop-blur-md p-4 transition-all duration-200 shadow-sm hover:shadow-md"
      aria-labelledby={titleId}
    >
      <header className="message-byline flex items-center justify-between mb-3">
        <div className="message-byline-main flex items-center gap-2.5 min-w-0">
          <div
            className="source-mark w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-inner shrink-0"
            style={{
              background: `linear-gradient(135deg, hsl(${markHue} 75% 45%), hsl(${markHue + 40} 80% 30%))`,
            }}
            aria-hidden="true"
          >
            {source.slice(0, 1).toUpperCase()}
          </div>

          <div className="min-w-0 flex flex-col">
            <div className="flex items-center gap-1.5 min-w-0">
              <h3 id={titleId} className="text-sm font-semibold text-zinc-100 truncate">
                {source}
              </h3>
              {speaker !== source && (
                <span className="byline-speaker text-xs text-zinc-400 truncate">· {speaker}</span>
              )}
            </div>
            <time dateTime={message.message_time} className="text-[11px] text-zinc-500">
              {formatTime(message.message_time)}
            </time>
          </div>
        </div>

        <div className="flex items-center gap-1 text-zinc-400 opacity-60 group-hover:opacity-100 transition-opacity">
          {message.source_url && (
            <>
              <button
                type="button"
                onClick={handleCopyLink}
                title="复制 Telegram 原文链接"
                className="p-1.5 hover:text-white hover:bg-white/5 rounded-md transition-colors cursor-pointer"
              >
                {copiedLink ? <Check size={14} className="text-emerald-400" /> : <LinkIcon size={14} />}
              </button>

              <a
                href={message.source_url}
                target="_blank"
                rel="noopener noreferrer"
                title="跳转 Telegram 查看原文"
                className="source-link inline-flex items-center gap-1 text-xs px-2 py-1 hover:text-white hover:bg-white/5 rounded-md transition-colors"
              >
                <span>原文</span>
                <ExternalLink size={12} />
              </a>
            </>
          )}
        </div>
      </header>

      {message.content ? (
        <RichContent content={message.content} />
      ) : (
        <p className="message-text text-xs text-zinc-500 italic">仅包含{mediaLabel(message.media_type || "text")}</p>
      )}

      {mediaItems.length ? (
        <div className="media-grid mt-3">
          <MediaGallery items={mediaItems} message={message} onOpenImage={onOpenImage} />
        </div>
      ) : null}

      {density === "console" ? (
        <footer className="message-foot mt-3 pt-2 border-t border-white/5 flex items-center justify-between text-[11px] text-zinc-500 font-mono">
          <span>消息 #{message.message_id}</span>
          {message.media_type && (
            <span className="media-badge px-1.5 py-0.5 rounded bg-white/5 text-zinc-400">
              {mediaLabel(message.media_type)}
            </span>
          )}
        </footer>
      ) : null}
    </article>
  );
}

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
      <div className="overflow-hidden rounded-lg max-h-[460px] bg-black/20 flex justify-center border border-white/5">
        <MediaAttachment item={items[0]} message={message} index={0} onOpenImage={onOpenImage} />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-1.5 overflow-hidden rounded-lg">
      {items.map((item, idx) => (
        <div key={idx} className="aspect-[4/3] overflow-hidden rounded-md bg-black/20 border border-white/5">
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
      <a className="media-fallback flex items-center gap-2 p-3 text-xs text-zinc-500 bg-white/5 rounded-lg hover:text-zinc-300" href={fallbackUrl} target="_blank" rel="noopener noreferrer">
        <ImageOff size={16} aria-hidden="true" />
        <span>媒体加载失败，打开原文</span>
      </a>
    );
  }

  if (["audio", "voice"].includes(kind) || ["audio", "voice"].includes(type)) {
    return (
      <div className="audio-card flex items-center gap-2 p-2 bg-white/5 rounded-lg border border-white/5">
        <Volume2 size={18} className="text-zinc-400" aria-hidden="true" />
        <audio className="audio-control w-full h-8" controls preload="metadata" aria-label={`${source}中的音频`} onError={() => setFailed(true)}>
          <source src={item.url} />
        </audio>
      </div>
    );
  }

  if (["document", "file"].includes(kind) || type === "document") {
    return (
      <a
        className="file-card flex items-center justify-between p-3 bg-white/5 hover:bg-white/10 rounded-lg border border-white/5 text-zinc-200 transition-colors group/file"
        href={item.url}
        download
        aria-label="下载文件"
      >
        <div className="flex items-center gap-2.5">
          <FileText size={20} className="text-blue-400" aria-hidden="true" />
          <div className="flex flex-col">
            <strong className="text-xs font-medium">附件文件</strong>
            <small className="text-[11px] text-zinc-400">通过受保护的媒体缓存下载</small>
          </div>
        </div>
        <span className="file-action inline-flex items-center gap-1 text-xs text-zinc-400 group-hover/file:text-white transition-colors">
          <Download size={14} aria-hidden="true" /> 下载文件
        </span>
      </a>
    );
  }

  if (["video", "animation"].includes(kind)) {
    return (
      <video
        className="media-video w-full h-full max-h-[460px] object-cover rounded-lg"
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
      className="media-image-trigger w-full h-full overflow-hidden flex items-center justify-center cursor-zoom-in bg-zinc-950/40 border-0 p-0"
      type="button"
      aria-label={`查看完整图片 ${index + 1}`}
      onClick={() => onOpenImage({
        src: item.original_url || item.url,
        alt: `${source}中${speaker}发布的完整图片 ${index + 1}`
      }, imageButtonRef.current)}
    >
      <img
        className={`media-image-contained w-full h-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100 is-loaded" : "opacity-0"}`}
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
        <div key={i} className="rounded-xl border border-white/5 bg-zinc-900/30 p-4 space-y-3 animate-pulse">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-white/10" />
            <div className="space-y-1.5">
              <div className="w-24 h-3.5 bg-white/10 rounded" />
              <div className="w-16 h-2.5 bg-white/5 rounded" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="w-full h-3 bg-white/10 rounded" />
            <div className="w-3/4 h-3 bg-white/5 rounded" />
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
          entry.message.content.trim() === m.content.trim()
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
