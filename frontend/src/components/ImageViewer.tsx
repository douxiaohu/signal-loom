import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, ExternalLink, Download } from "lucide-react";

import { useLatest } from "../hooks/useLatest";

type ImageViewerProps = {
  src: string;
  alt: string;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
};

export default function ImageViewer({ src, alt, returnFocusRef, onClose }: ImageViewerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Read through a ref so that a parent re-render (new onClose identity) does not
  // re-run the effect below, which would steal focus and flicker the page lock.
  const latestClose = useLatest(onClose);

  useEffect(() => {
    closeRef.current?.focus();
    document.body.classList.add("viewer-open");

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        latestClose.current();
        return;
      }
      if (event.key === "Tab") {
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

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md transition-opacity duration-200"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={onClose}
    >
      <div
        className="relative max-w-[95vw] max-h-[92vh] flex flex-col items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部悬浮控制栏 */}
        <div className="absolute -top-12 right-0 flex items-center gap-2 z-50">
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            title="在新标签页中打开原图"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-white bg-zinc-900/80 hover:bg-zinc-800 border border-white/10 rounded-full backdrop-blur transition-all duration-150"
          >
            <ExternalLink size={13} />
            <span>原图</span>
          </a>

          <a
            href={src}
            download
            title="下载原图"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-white bg-zinc-900/80 hover:bg-zinc-800 border border-white/10 rounded-full backdrop-blur transition-all duration-150"
          >
            <Download size={13} />
            <span>下载</span>
          </a>

          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="关闭图片预览"
            className="p-1.5 text-zinc-300 hover:text-white bg-zinc-900/80 hover:bg-zinc-800 border border-white/10 rounded-full backdrop-blur transition-all duration-150 cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* 高清大图展示 */}
        <div className="relative overflow-hidden rounded-xl border border-white/10 shadow-2xl bg-zinc-950/90 flex items-center justify-center max-h-[85vh]">
          <img
            src={src}
            alt={alt}
            className="max-w-[92vw] max-h-[85vh] w-auto h-auto object-contain select-none"
            loading="eager"
            decoding="async"
          />
        </div>
      </div>
    </div>,
    document.body
  );
}
