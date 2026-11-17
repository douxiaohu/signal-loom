import { lazy, memo, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  BookmarkCheck,
  Check,
  Copy,
  ExternalLink,
  Link as LinkIcon,
  Sparkles,
  X,
} from "lucide-react";

import { useI18n, translate } from "../../i18n";
import { useSite, messageUrl } from "../../site";
import { useReaderLibrary } from "../../hooks/useReaderLibrary";
import { useCopyFeedback, type CopyState } from "../../hooks/useCopyFeedback";
import type { Message } from "../../types";
import {
  cleanMessageContent,
  formatTime,
  mediaLabel,
  sourceHue,
} from "../../utils";
import RichContent from "../RichContent";
import MediaGallery, { mediaItemsOf } from "./MediaGallery";
import AsyncModal from "../AsyncModal";
const ShareCardModal = lazy(() => import("./ShareCardModal"));
import type { FeedDensity, OpenImageHandler } from "./types";

type MessageCardProps = {
  density: FeedDensity;
  message: Message;
  onOpenImage: OpenImageHandler;
  compact?: boolean;
};

function MessageCard({
  density,
  message,
  onOpenImage,
  compact = false,
}: MessageCardProps) {
  const { t } = useI18n();
  const site = useSite();
  const library = useReaderLibrary();
  const saved = library.ids.includes(message.id);
  const copySite = useCopyFeedback();
  const copyLink = useCopyFeedback();
  const copyBody = useCopyFeedback();
  const [sharing, setSharing] = useState(false);
  const shareRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const mediaItems = mediaItemsOf(message);
  const speaker = message.sender_name || t("未知发送者");
  const source = message.chat_title || t("未知来源");
  const titleId = `message-${message.id}-title`;
  const markHue = sourceHue(`${message.chat_id ?? source}`);
  const cleanedContent = cleanMessageContent(message.content);

  useEffect(() => {
    const card = cardRef.current;
    if (
      !card ||
      density !== "reading" ||
      !window.IntersectionObserver ||
      !window.matchMedia ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    let disposed = false;
    let stop = () => {};
    void import("../editorial/assembly-runtime")
      .then(({ mountMessageAssembly }) => {
        if (!disposed)
          stop = mountMessageAssembly(
            card,
            String(message.id),
            `${message.message_time}:${message.content}`,
          );
      })
      .catch(() => {
        /* Reading stays complete if the optional animation cannot load. */
      });
    return () => {
      disposed = true;
      stop();
    };
  }, [density, message]);

  return (
    <>
      <article
        ref={cardRef}
        className={`pub-card message-card${density === "console" ? " is-console" : " is-reading"}${compact ? " is-nested" : ""}`}
        data-message-id={message.id}
        aria-labelledby={titleId}
      >
        <header className="pub-card-head">
          <div className="pub-source-id">
            <span
              className="pub-avatar source-mark"
              aria-hidden="true"
              style={{
                background: `linear-gradient(140deg, hsl(${markHue} 55% 46%), hsl(${markHue + 42} 58% 32%))`,
                color: "#fff",
              }}
            >
              {source.slice(0, 1).toUpperCase()}
            </span>

            <div className="pub-card-name">
              <h3 id={titleId} className="pub-card-source">
                {source}
              </h3>
              <div className="pub-card-sub">
                {speaker !== source && (
                  <>
                    <span className="byline-speaker pub-sender">
                      · {speaker}
                    </span>
                    <span className="pub-sep" aria-hidden="true">
                      /
                    </span>
                  </>
                )}
                <time dateTime={message.message_time} className="pub-card-time">
                  {formatTime(message.message_time)}
                </time>
              </div>
            </div>
          </div>

          <div className="pub-card-actions">
            {density === "reading" && (
              <>
                <button
                  type="button"
                  aria-pressed={saved}
                  aria-label={t(saved ? "取消收藏" : "收藏消息")}
                  title={t(saved ? "取消收藏" : "收藏消息")}
                  onClick={() => library.toggle(message.id)}
                >
                  {saved ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
                </button>
                <button
                  type="button"
                  aria-label={t("复制本站链接")}
                  title={t(
                    copySite.state === "copied" ? "已复制" : "复制本站链接",
                  )}
                  onClick={() =>
                    void copySite.copy(messageUrl(site, message.id))
                  }
                >
                  {copySite.state === "copied" ? (
                    <Check size={14} />
                  ) : (
                    <LinkIcon size={14} />
                  )}
                </button>
              </>
            )}
            <button
              type="button"
              ref={shareRef}
              onClick={(e) => {
                e.stopPropagation();
                setSharing(true);
              }}
              title={t("生成分享卡片")}
              aria-label={t("生成分享卡片")}
              className="pub-share-trigger"
            >
              <Sparkles size={14} aria-hidden="true" />
            </button>

            {cleanedContent && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void copyBody.copy(cleanedContent);
                }}
                title={copyTitle(copyBody.state, "复制正文")}
                aria-label={copyLabel(copyBody.state, "复制正文内容")}
                className={copyBody.state === "copied" ? "is-done" : undefined}
              >
                <CopyIcon state={copyBody.state} idle={<Copy size={14} />} />
              </button>
            )}

            {message.source_url && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void copyLink.copy(message.source_url);
                  }}
                  title={copyTitle(copyLink.state, "复制原文链接")}
                  aria-label={copyLabel(
                    copyLink.state,
                    "复制 Telegram 原文链接",
                  )}
                  className={
                    copyLink.state === "copied" ? "is-done" : undefined
                  }
                >
                  <CopyIcon
                    state={copyLink.state}
                    idle={<LinkIcon size={14} />}
                  />
                </button>

                <a
                  href={message.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t("在 Telegram 查看原文")}
                  className="source-link pub-card-action-wide"
                >
                  <span>{t("原文")}</span>
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              </>
            )}
          </div>
        </header>

        {cleanedContent ? (
          <RichContent content={cleanedContent} />
        ) : (
          <p className="pub-media-note message-text">
            {t("仅包含{type}", {
              type: mediaLabel(message.media_type || "text"),
            })}
          </p>
        )}

        {mediaItems.length ? (
          <div className="pub-media media-grid">
            <MediaGallery
              items={mediaItems}
              message={message}
              onOpenImage={onOpenImage}
            />
          </div>
        ) : null}

        {density === "console" ? (
          <footer className="pub-card-foot message-foot">
            <span>消息 #{message.message_id}</span>
            {message.media_type && (
              <span className="media-badge">
                {mediaLabel(message.media_type)}
              </span>
            )}
          </footer>
        ) : null}
      </article>
      {sharing ? (
        <AsyncModal
          label={t("分享卡片")}
          onClose={() => setSharing(false)}
          returnFocusRef={shareRef}
        >
          <ShareCardModal
            message={message}
            returnFocusRef={shareRef}
            onClose={() => setSharing(false)}
          />
        </AsyncModal>
      ) : null}
    </>
  );
}

function CopyIcon({
  state,
  idle,
}: {
  state: CopyState;
  idle: React.ReactNode;
}) {
  if (state === "copied") return <Check size={14} />;
  if (state === "failed") return <X size={14} />;
  return <>{idle}</>;
}

const copyTitle = (state: CopyState, idle: string) =>
  translate(state === "failed" ? "复制失败，请手动选择文字" : idle);
const copyLabel = (state: CopyState, idle: string) =>
  translate(state === "failed" ? "复制失败" : idle);

/** Cards only re-render when their own message changes, not whenever the list around them does. */
export default memo(MessageCard);
