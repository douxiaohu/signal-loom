import { useEffect } from "react";

import { useLatest } from "./useLatest";

/**
 * Calls `callback` every `intervalMs` while `enabled`, skipping ticks that land
 * while the tab is hidden (a background tab should not keep hitting the API).
 * The latest callback is always the one that runs, so it may close over state
 * without restarting the timer.
 */
export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const latest = useLatest(callback);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      latest.current();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, latest]);
}
