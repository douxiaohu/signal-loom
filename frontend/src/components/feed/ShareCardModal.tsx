import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Download, X } from "lucide-react";

import { useLatest } from "../../hooks/useLatest";
import { copyImage } from "../../lib/clipboard";
import { renderShareCard } from "../../lib/shareCard";
import type { Message } from "../../types";

type ShareCardModalProps = {
  message: Message;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
};

type Status = "loading" | "ready" | "error";
type CopyState = "idle" | "copied" | "failed";

export default function ShareCardModal({ message, returnFocusRef, onClose }: ShareCardModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const blobRef = useRef<Blob | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [url, setUrl] = useState("");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const latestClose = useLatest(onClose);

  // Generate the card image once; revoke its object URL on unmount.
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    renderShareCard(message)
      .then((result) => {
        if (!active) {
          if (result.url.startsWith("blob:")) URL.revokeObjectURL(result.url);
          return;
        }
        blobRef.current = result.blob;
        objectUrl = result.url;
        setUrl(result.url);
        setStatus("ready");
      })
      .catch(() => {
        if (active) setStatus("error");
      });
    return () => {
      active = false;
      if (objectUrl.startsWith("blob:")) URL.revokeObjectURL(objectUrl);
    };
  }, [message]);

  // Focus the close button, lock the page, close on Escape.
  useEffect(() => {
    closeRef.current?.focus();
    document.body.classList.add("viewer-open");
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        latestClose.current();
      } else if (event.key === "Tab") {
        event.preventDefault();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
      returnFocusRef?.current?.focus();
    };
  }, [latestClose, returnFocusRef]);

  const handleCopy = useCallback(async () => {
    if (!blobRef.current) return;
    const ok = await copyImage(blobRef.current);
    setCopyState(ok ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1800);
  }, []);

  const handleDownload = useCallback(() => {
    if (!url) return;
    const safeSource = (message.chat_title || "频道资讯").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 24);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `频道资讯-${safeSource}-${message.message_id}.png`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [url, message]);

  const copyLabel = copyState === "copied" ? "已复制" : copyState === "failed" ? "改用下载" : "复制图片";

  return createPortal(
    <div className="pub-share-overlay" role="dialog" aria-modal="true" aria-label="分享卡片" onClick={onClose}>
      <div className="pub-share-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="pub-share-bar">
          <span className="pub-share-heading">分享卡片</span>
          <div className="pub-share-tools">
            <button
              type="button"
              className={`pub-share-btn${copyState === "copied" ? " is-done" : ""}`}
              onClick={handleCopy}
              disabled={status !== "ready"}
            >
              {copyState === "copied" ? <Check size={15} aria-hidden="true" /> : copyState === "failed" ? <X size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
              <span>{copyLabel}</span>
            </button>
            <button type="button" className="pub-share-btn" onClick={handleDownload} disabled={status !== "ready"}>
              <Download size={15} aria-hidden="true" />
              <span>下载图片</span>
            </button>
            <button ref={closeRef} type="button" className="pub-share-close" onClick={onClose} aria-label="关闭分享卡片">
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="pub-share-stage">
          {status === "loading" ? (
            <div className="pub-share-state" role="status">
              <span className="pub-share-spinner" aria-hidden="true" />
              正在生成分享卡片…
            </div>
          ) : status === "error" ? (
            <div className="pub-share-state">无法生成分享卡片，请稍后再试。</div>
          ) : (
            <img className="pub-share-image" src={url} alt="新闻分享卡片预览" />
          )}
        </div>

        <p className="pub-share-hint">复制后可直接粘贴到聊天或笔记；部分浏览器不支持复制图片，可改用「下载图片」保存 PNG。</p>
      </div>
    </div>,
    document.body
  );
}
