import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, Copy, Download, X } from "lucide-react";

import { useLatest } from "../../hooks/useLatest";
import { copyImage } from "../../lib/clipboard";
import type { ShareCardResult } from "../../lib/shareCard";
import type { Message } from "../../types";

type ShareCardModalProps = {
  message: Message;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
};

export default function ShareCardModal({ message, returnFocusRef, onClose }: ShareCardModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef(0);
  const [result, setResult] = useState<ShareCardResult | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [pageIndex, setPageIndex] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const latestClose = useLatest(onClose);
  const page = result?.pages[pageIndex];

  useEffect(() => {
    const controller = new AbortController();
    let rendered: ShareCardResult | null = null;
    setStatus("loading");
    setResult(null);
    setPageIndex(0);
    // The renderer and archive builder are optional and stay out of the reading bundle.
    void import("../../lib/shareCard").then(({ renderShareCard }) => renderShareCard(message, { signal: controller.signal })).then((next) => {
      rendered = next;
      if (controller.signal.aborted) { next.pages.forEach(({ url }) => URL.revokeObjectURL(url)); return; }
      setResult(next);
      setStatus("ready");
    }).catch(() => { if (!controller.signal.aborted) setStatus("error"); });
    return () => {
      controller.abort();
      rendered?.pages.forEach(({ url }) => URL.revokeObjectURL(url));
      clearTimeout(copyTimer.current);
    };
  }, [message]);

  useEffect(() => { if (stageRef.current) stageRef.current.scrollTop = 0; setCopyState("idle"); clearTimeout(copyTimer.current); }, [pageIndex]);

  useEffect(() => {
    closeRef.current?.focus();
    document.body.classList.add("viewer-open");
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); latestClose.current(); return; }
      if (event.key !== "Tab") return;
      const buttons = [...dialogRef.current!.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
      returnFocusRef?.current?.focus();
    };
  }, [latestClose, returnFocusRef]);

  const handleCopy = useCallback(async () => {
    if (!page) return;
    const index = pageIndex;
    const ok = await copyImage(page.blob);
    // An old copy result must not announce success for a different page.
    if (stageRef.current?.dataset.page !== String(index)) return;
    setCopyState(ok ? "copied" : "failed");
    clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState("idle"), 1800);
  }, [page, pageIndex]);

  const handleDownload = useCallback(async () => {
    if (!result || downloading) return;
    setDownloading(true);
    setDownloadError("");
    const safeSource = (message.chat_title || "拾讯").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 24);
    let zipUrl = "";
    try {
      if (result.pages.length > 1) {
        const { packageSharePages } = await import("../../lib/shareCard");
        zipUrl = URL.createObjectURL(await packageSharePages(result.pages));
      }
      if (!dialogRef.current) return;
      const anchor = document.createElement("a");
      anchor.href = zipUrl || result.pages[0].url;
      anchor.download = `拾讯-${safeSource}-${message.message_id}${zipUrl ? "-全部.zip" : ".png"}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch { if (dialogRef.current) setDownloadError("打包失败，请稍后重试。"); }
    finally {
      if (zipUrl) window.setTimeout(() => URL.revokeObjectURL(zipUrl), 1000);
      if (dialogRef.current) setDownloading(false);
    }
  }, [result, downloading, message]);

  const many = (result?.pages.length || 0) > 1;
  const copyLabel = copyState === "copied" ? "已复制" : copyState === "failed" ? "改用下载" : many ? "复制当前页" : "复制图片";

  return createPortal(
    <div className="pub-share-overlay" role="dialog" aria-modal="true" aria-label="分享卡片" onClick={onClose}>
      <div className="pub-share-dialog" ref={dialogRef} onClick={(event) => event.stopPropagation()}>
        <div className="pub-share-bar">
          <span className="pub-share-heading">分享卡片</span>
          <div className="pub-share-tools">
            <button type="button" className={`pub-share-btn${copyState === "copied" ? " is-done" : ""}`} onClick={() => void handleCopy()} disabled={status !== "ready"}>
              {copyState === "copied" ? <Check size={15} aria-hidden="true" /> : copyState === "failed" ? <X size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}<span>{copyLabel}</span>
            </button>
            <button type="button" className="pub-share-btn" onClick={() => void handleDownload()} disabled={status !== "ready" || downloading}>
              <Download size={15} aria-hidden="true" /><span>{downloading ? "正在打包…" : many ? "下载全部" : "下载图片"}</span>
            </button>
            <button ref={closeRef} type="button" className="pub-share-close" onClick={onClose} aria-label="关闭分享卡片"><X size={18} aria-hidden="true" /></button>
          </div>
        </div>
        {result && <div className="pub-share-pagination">
          <span role="status">{result.imageCount} 张图片 · {result.pages.length} 页</span>
          {many && <div className="pub-share-page-controls"><button type="button" aria-label="上一页分享卡片" disabled={pageIndex === 0} onClick={() => setPageIndex((value) => value - 1)}><ChevronLeft size={17} aria-hidden="true" /></button><span>{pageIndex + 1} / {result.pages.length}</span><button type="button" aria-label="下一页分享卡片" disabled={pageIndex === result.pages.length - 1} onClick={() => setPageIndex((value) => value + 1)}><ChevronRight size={17} aria-hidden="true" /></button></div>}
        </div>}
        <div className="pub-share-stage" ref={stageRef} data-page={pageIndex} tabIndex={0} role="region" aria-label="分享卡片内容">
          {status === "loading" ? <div className="pub-share-state" role="status"><span className="pub-share-spinner" aria-hidden="true" />正在生成完整分享卡片…</div>
            : status === "error" ? <div className="pub-share-state" role="alert">无法生成分享卡片，请稍后再试。</div>
            : page ? <img className="pub-share-image" src={page.url} width={page.width} height={page.height} alt={`新闻分享卡片预览，第 ${pageIndex + 1} 页，共 ${result!.pages.length} 页`} /> : null}
        </div>
        <p className="pub-share-hint">长卡片可滚动查看，长文和多图自动分页。{many ? "复制当前页，或下载全部 PNG（ZIP）。" : "可复制或下载 PNG 图片。"}{result?.failedImages ? `有 ${result.failedImages} 张图片暂未加载，卡片中已标明，可稍后重试。` : ""}{copyState === "failed" ? "当前浏览器不支持复制，请使用下载。" : ""}{downloadError}</p>
      </div>
    </div>, document.body
  );
}
