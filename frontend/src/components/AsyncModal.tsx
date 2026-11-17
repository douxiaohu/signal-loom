import { Suspense, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useI18n } from "../i18n";
import ErrorBoundary from "./ErrorBoundary";

type Props = {
  label: string;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
  children: ReactNode;
};

/** Keep optional dialogs responsive and dismissible while their code is loading. */
function Placeholder({
  label,
  onClose,
  returnFocusRef,
  failed = false,
}: Omit<Props, "children"> & { failed?: boolean }) {
  const { t } = useI18n();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    document.body.classList.add("viewer-open");
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        event.preventDefault();
        close.current?.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
      document.body.classList.remove("viewer-open");
      returnFocusRef?.current?.focus();
    };
  }, [onClose, returnFocusRef]);
  return createPortal(
    <div
      className="pub-share-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
    >
      <div
        className="pub-share-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pub-share-bar">
          <span>{label}</span>
          <button
            ref={close}
            type="button"
            className="pub-share-close"
            aria-label={t("关闭")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="pub-share-state" role={failed ? "alert" : "status"}>
          {t(failed ? "暂时无法打开，请刷新页面后重试。" : "正在加载…")}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function AsyncModal({ children, ...props }: Props) {
  return (
    <ErrorBoundary fallback={<Placeholder {...props} failed />}>
      <Suspense fallback={<Placeholder {...props} />}>{children}</Suspense>
    </ErrorBoundary>
  );
}
