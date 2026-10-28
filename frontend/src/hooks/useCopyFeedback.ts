import { useCallback, useEffect, useRef, useState } from "react";

import { copyText } from "../lib/clipboard";

export type CopyState = "idle" | "copied" | "failed";

/**
 * Copies text and reports the outcome for a couple of seconds ("copied" or
 * "failed"). A second copy restarts the countdown, and nothing is left running
 * once the component is gone.
 */
export function useCopyFeedback(resetMs = 2000) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      if (!mounted.current) return;
      setState(ok ? "copied" : "failed");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), resetMs);
    },
    [resetMs]
  );

  return { state, copy };
}
