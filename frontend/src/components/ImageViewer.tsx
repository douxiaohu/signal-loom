import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";


type ImageViewerProps = {
  alt: string;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  src: string;
  onClose: () => void;
};


export default function ImageViewer({ alt, returnFocusRef, src, onClose }: ImageViewerProps) {
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
      if (event.key === "Tab") event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
      returnFocusRef.current?.focus();
    };
  }, [onClose, returnFocusRef]);

  return createPortal(
    <div
      className="image-viewer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={onClose}
    >
      <button ref={closeRef} className="image-viewer-close" type="button" onClick={onClose} aria-label="关闭图片预览">
        <X size={22} aria-hidden="true" />
      </button>
      <img className="image-viewer-image" src={src} alt={alt} />
    </div>,
    document.body
  );
}
