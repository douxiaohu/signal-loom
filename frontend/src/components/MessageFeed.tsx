import { useRef, useState } from "react";
import { Download, ExternalLink, FileText, ImageOff, Play, Volume2 } from "lucide-react";

import type { MediaItem, Message } from "../types";
import { cleanMessageContent, formatDate, mediaLabel } from "../utils";
import ImageViewer from "./ImageViewer";

type MessageFeedProps = {
  hasMore: boolean;
  initialLoading: boolean;
  loadingMore: boolean;
  messages: Message[];
  onLoadMore: () => void;
};

export default function MessageFeed({ hasMore, initialLoading, loadingMore, messages, onLoadMore }: MessageFeedProps) {
  return (
    <main id="message-list" className="message-list" aria-label="消息时间线" tabIndex={-1}>
      {initialLoading && !messages.length ? <MessageSkeleton /> : null}
      {messages.map((message) => <MessageCard key={message.id} message={message} />)}
      {!initialLoading && hasMore ? (
        <button className="load-more" type="button" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? "正在加载更多…" : "加载更多"}
        </button>
      ) : !initialLoading && messages.length ? (
        <div className="feed-end">已显示全部匹配消息</div>
      ) : !initialLoading ? (
        <div className="empty-state">
          <strong>没有匹配消息</strong>
          <span>调整来源、媒体类型或关键词后再试。</span>
        </div>
      ) : null}
    </main>
  );
}

export function MessageCard({ message }: { message: Message }) {
  const mediaItems = normalizedMediaItems(message);
  const speaker = message.sender_name || "未知发送者";
  const source = message.chat_title || "未知来源";
  const titleId = `message-${message.id}-title`;
  const content = cleanMessageContent(message.content);
  return (
    <article className="message-card" aria-labelledby={titleId}>
      <header className="message-head">
        <div className="message-identity">
          <span className="source-mark" aria-hidden="true">{source.slice(0, 1).toUpperCase()}</span>
          <div>
            <h3 id={titleId}>{source}</h3>
            <div className="message-meta">
              <span>{speaker}</span>
              <time dateTime={message.message_time}>{formatDate(message.message_time)}</time>
              {message.media_type ? <span className="media-badge">{mediaLabel(message.media_type)}</span> : null}
            </div>
          </div>
        </div>
        {message.source_url ? (
          <a className="source-link" href={message.source_url} target="_blank" rel="noopener noreferrer">
            原文 <ExternalLink size={15} aria-hidden="true" />
          </a>
        ) : null}
      </header>
      {content ? <p className="message-text">{content}</p> : <p className="message-text muted-copy">仅包含{mediaLabel(message.media_type || "text")}</p>}
      {mediaItems.length ? (
        <div className="media-grid">
          {mediaItems.map((item, index) => <MediaAttachment key={`${item.url}-${index}`} item={item} message={message} index={index} />)}
        </div>
      ) : null}
      <footer className="message-foot">
        <span>消息 #{message.message_id}</span>
      </footer>
    </article>
  );
}

function MediaAttachment({ item, message, index }: { item: MediaItem; message: Message; index: number }) {
  const [failed, setFailed] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
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
        <img src={item.url} alt={`${source}中${speaker}发布的视频封面`} width="800" height="450" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        <span className="play-mark" aria-hidden="true"><Play size={22} fill="currentColor" /></span>
        <span>打开原文播放</span>
      </a>
    );
  }
  return (
    <>
      <button
        ref={imageButtonRef}
        className="media-image-trigger"
        type="button"
        aria-label={`查看完整图片 ${index + 1}`}
        onClick={() => setViewerOpen(true)}
      >
        <img
          className="media-image-contained"
          src={item.url}
          alt={`${source}中${speaker}发布的图片 ${index + 1}`}
          width="800"
          height="500"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </button>
      {viewerOpen ? (
        <ImageViewer
          src={item.original_url || item.url}
          alt={`${source}中${speaker}发布的完整图片 ${index + 1}`}
          returnFocusRef={imageButtonRef}
          onClose={() => setViewerOpen(false)}
        />
      ) : null}
    </>
  );
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
