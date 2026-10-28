import { useRef, useState } from "react";
import { Download, ExternalLink, FileText, ImageOff, Volume2 } from "lucide-react";

import type { MediaItem, Message } from "../../types";
import type { OpenImageHandler } from "./types";

/** The attachments of a message; older rows only carry `media_urls`. */
export function mediaItemsOf(message: Message): MediaItem[] {
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

export default function MediaGallery({
  items,
  message,
  onOpenImage
}: {
  items: MediaItem[];
  message: Message;
  onOpenImage: OpenImageHandler;
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
  onOpenImage: OpenImageHandler;
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
