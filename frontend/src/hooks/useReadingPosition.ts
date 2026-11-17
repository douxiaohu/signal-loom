import { useEffect, useState } from "react";
import { safeStorage } from "../lib/storage";
import type { Message } from "../types";
const key = "signal-reading-position";
export type ReadingPosition = { id: number; url: string; offset: number };
export function readPosition(): ReadingPosition | null {
  try {
    const value = JSON.parse(safeStorage.get(key) || "null");
    return value &&
      Number.isSafeInteger(value.id) &&
      value.id > 0 &&
      typeof value.url === "string" &&
      /^\/(?:\?[^#]*)?$/.test(value.url) &&
      Number.isFinite(value.offset)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function useReadingPosition(
  messages: Message[],
  loading: boolean,
  hasMore: boolean,
  loadMore: () => void,
) {
  const [position, setPosition] = useState(readPosition);
  const [resume] = useState(() =>
    Number(new URLSearchParams(location.search).get("resume")),
  );
  const [restoring, setRestoring] = useState(
    Number.isSafeInteger(resume) && resume > 0,
  );
  const [attempts, setAttempts] = useState(0);
  useEffect(() => {
    if (!restoring || loading) return;
    const card = document.querySelector<HTMLElement>(
      `[data-message-id="${resume}"]`,
    );
    if (card) {
      const saved = readPosition();
      const frame = requestAnimationFrame(() => {
        window.scrollTo(
          0,
          window.scrollY +
            card.getBoundingClientRect().top -
            (saved?.id === resume ? saved.offset : 100),
        );
        setRestoring(false);
        const url = new URL(location.href);
        url.searchParams.delete("resume");
        history.replaceState(null, "", url.pathname + url.search);
      });
      return () => cancelAnimationFrame(frame);
    }
    if (hasMore && attempts < 25) {
      setAttempts((n) => n + 1);
      loadMore();
    } else {
      setRestoring(false);
      window.location.assign(`/message/${resume}`);
    }
  }, [messages, loading, hasMore, restoring, resume, attempts, loadMore]);
  useEffect(() => {
    if (restoring) return;
    let timer = 0;
    const save = () => {
      if (window.scrollY < 100) return;
      const cards = [
        ...document.querySelectorAll<HTMLElement>(
          ".is-reading[data-message-id]",
        ),
      ];
      const card = cards.find(
        (node) => node.getBoundingClientRect().bottom > 120,
      );
      if (!card) return;
      const params = new URLSearchParams(location.search);
      params.delete("resume");
      safeStorage.set(
        key,
        JSON.stringify({
          id: Number(card.dataset.messageId),
          url: "/" + (params.size ? "?" + params : ""),
          offset: card.getBoundingClientRect().top,
        }),
      );
    };
    const scroll = () => {
      clearTimeout(timer);
      timer = window.setTimeout(save, 350);
    };
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("pagehide", save);
    };
  }, [restoring, messages]);
  return {
    position,
    forget: () => {
      safeStorage.set(key, "null");
      setPosition(null);
    },
    href: position
      ? position.url +
        (position.url.includes("?") ? "&" : "?") +
        "resume=" +
        position.id
      : "/",
  };
}
