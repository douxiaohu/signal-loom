import { useEffect, useRef } from "react";
import { X } from "lucide-react";


type ImageViewerProps = {
  alt: string;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  src: string;
  onClose: () => void;
};


export default function ImageViewer({ alt, returnFocusRef, src, onClose }: ImageViewerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    document.body.classList.add("viewer-open");
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])') || []
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
      returnFocusRef.current?.focus();
    };
  }, [onClose, returnFocusRef]);

  return (
    <div
      className="image-viewer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="image-viewer-panel" ref={panelRef}>
        <button ref={closeRef} className="image-viewer-close" type="button" onClick={onClose} aria-label="关闭图片预览">
          <X size={22} aria-hidden="true" />
        </button>
        <img className="image-viewer-image" src={src} alt={alt} />
      </div>
    </div>
  );
}
