import { useCallback, useEffect, useRef, useState } from "react";

import { filterKey } from "../lib/filters";
import type { Filters } from "../types";
import { useLatest } from "./useLatest";

type UseUrlFiltersOptions = {
  /** Reads the filters from the address bar (initial value and back/forward). */
  read: () => Filters;
  /** The URL (path + query) that represents `filters`. */
  toUrl: (filters: Filters) => string;
  /** Called after back/forward changed the address, so the caller can resync its own state. */
  onRestore?: (filters: Filters) => void;
};

/**
 * The committed filters of a list page, kept in step with the address bar:
 * committing pushes a history entry (once per distinct URL) and the browser's
 * back/forward buttons restore earlier filters.
 */
export function useUrlFilters(options: UseUrlFiltersOptions) {
  const latest = useLatest(options);
  const [initial] = useState<Filters>(() => options.read());
  const [filters, setFilters] = useState<Filters>(initial);
  const committed = useRef<Filters>(initial);

  /**
   * Applies `next`; returns false when it selects the list that is already shown.
   * `replace` rewrites the current history entry instead of adding one (for
   * corrections the reader did not ask for, so "back" does not return to them).
   */
  const commit = useCallback(
    (next: Filters, options: { replace?: boolean } = {}): boolean => {
      const url = latest.current.toUrl(next);
      if (url !== `${window.location.pathname}${window.location.search}`) {
        if (options.replace) window.history.replaceState(null, "", url);
        else window.history.pushState(null, "", url);
      }
      const changed = filterKey(committed.current) !== filterKey(next);
      committed.current = next;
      setFilters(next);
      return changed;
    },
    [latest]
  );

  useEffect(() => {
    function restore() {
      const next = latest.current.read();
      committed.current = next;
      setFilters(next);
      latest.current.onRestore?.(next);
    }
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [latest]);

  return { filters, commit };
}
