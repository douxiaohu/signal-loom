import { useCallback, useEffect, useState } from "react";

import { fetchVisits } from "../api";
import type { VisitRecord, VisitStats } from "../types";
import { errorHelp, errorMessage } from "../utils";

type UseVisitsOptions = {
  authenticated: boolean;
  /** Visits are only fetched while their view is open. */
  active: boolean;
  onUnauthorized: (caught: unknown) => void;
};

/** The visit log. It is fetched whenever its view opens, cancelled when it closes and dropped on sign-out. */
export function useVisits({ authenticated, active, onUnauthorized }: UseVisitsOptions) {
  const [items, setItems] = useState<VisitRecord[]>([]);
  const [stats, setStats] = useState<VisitStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (authenticated) return;
    setItems((current) => (current.length ? [] : current));
    setStats(null);
    setError("");
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || !active) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetchVisits(controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setItems(payload.items);
        setStats(payload.stats);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        onUnauthorized(caught);
        setError(errorHelp(errorMessage(caught)));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [authenticated, active, reloadToken, onUnauthorized]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);
  return { items, stats, loading, error, reload };
}
