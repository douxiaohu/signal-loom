import { useCallback, useEffect, useState } from "react";

import { dedupeMessages, filterKey } from "../lib/filters";
import type { Filters, Message, MessagePage } from "../types";
import { errorMessage } from "../utils";
import { useLatest } from "./useLatest";
import { usePolling } from "./usePolling";

type UseNewMessageWatcherOptions = {
  enabled: boolean;
  /** The filters of the list on screen; a check only counts if they have not changed meanwhile. */
  filters: Filters;
  /** The messages on screen: anything already in here is not "new". */
  messages: Message[];
  /** Changes when the list is reloaded, which forgets whatever was waiting. */
  generation: number;
  fetchPage: (filters: Filters) => Promise<MessagePage>;
  formatError?: (caught: unknown) => string;
  onError?: (caught: unknown) => void;
  intervalMs?: number;
};

/**
 * Looks for messages newer than what is on screen once a minute and holds them
 * back instead of shifting the list under the reader's eyes; the caller decides
 * when to reveal them.
 */
export function useNewMessageWatcher(options: UseNewMessageWatcherOptions) {
  const { enabled, generation, intervalMs = 60_000 } = options;
  const latest = useLatest(options);
  const [pending, setPending] = useState<Message[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    setPending([]);
    setError("");
  }, [generation]);

  const check = useCallback(async () => {
    const { filters } = latest.current;
    const key = filterKey(filters);
    try {
      const page = await latest.current.fetchPage(filters);
      if (key !== filterKey(latest.current.filters)) return;
      const visible = new Set(latest.current.messages.map((message) => message.id));
      setPending((current) => dedupeMessages([...page.items.filter((item) => !visible.has(item.id)), ...current]));
      setError("");
    } catch (caught) {
      latest.current.onError?.(caught);
      setError((latest.current.formatError ?? errorMessage)(caught));
    }
  }, [latest]);

  usePolling(() => void check(), intervalMs, enabled);

  const clear = useCallback(() => setPending([]), []);
  return { pending, error, clear };
}
