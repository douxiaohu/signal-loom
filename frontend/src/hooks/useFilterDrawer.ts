import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The filter drawer of the message view: remembers what had focus so closing
 * (the scrim, Escape or applying the filters) hands focus back to it.
 */
export function useFilterDrawer() {
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  const show = useCallback(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => returnFocus.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  return { open, show, close };
}
