import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchAlertRules, fetchAlerts, fetchGroups, fetchOperations, fetchOverview } from "../api";
import type { AdminOverview, AlertMatch, AlertRule, Group, ManagedSource, OperationSummary } from "../types";
import { errorHelp, errorMessage } from "../utils";
import { usePolling } from "./usePolling";

const EMPTY_OPERATIONS: OperationSummary = { sources: [], unhealthy_sources: [] };
const REFRESH_INTERVAL_MS = 30_000;

type LoadOptions = {
  /** A scheduled refresh: an error already on screen stays put instead of blinking. */
  background?: boolean;
};

type UseAdminDataOptions = {
  authenticated: boolean;
  onUnauthorized: (caught: unknown) => void;
};

const emptied = <T,>(list: T[]) => (list.length ? [] : list);

/**
 * The console's server state: sources, the operations summary, rule matches,
 * rules and the overview. It is loaded after sign-in, refreshed every 30 seconds
 * while the tab is visible and dropped on sign-out. Only the newest request of
 * each kind may update the screen, so a slow older answer cannot undo a fresh one.
 */
export function useAdminData({ authenticated, onUnauthorized }: UseAdminDataOptions) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [operations, setOperations] = useState<OperationSummary>(EMPTY_OPERATIONS);
  const [alerts, setAlerts] = useState<AlertMatch[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [operationsError, setOperationsError] = useState("");
  const sourcesRequest = useRef(0);
  const operationsRequest = useRef(0);

  const loadSources = useCallback(async (options: LoadOptions = {}) => {
    const mine = ++sourcesRequest.current;
    if (!options.background) setSourceError("");
    try {
      const items = await fetchGroups();
      if (mine !== sourcesRequest.current) return;
      setGroups(items);
      setSourceError("");
    } catch (caught) {
      onUnauthorized(caught);
      if (mine === sourcesRequest.current) setSourceError(errorHelp(errorMessage(caught)));
    }
  }, [onUnauthorized]);

  const loadOperations = useCallback(async (options: LoadOptions = {}) => {
    const mine = ++operationsRequest.current;
    if (!options.background) setOperationsError("");
    const results = await Promise.allSettled([fetchOperations(), fetchAlerts(), fetchAlertRules(), fetchOverview()]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    failures.forEach((failure) => onUnauthorized(failure.reason));
    if (mine !== operationsRequest.current) return;
    if (results[0].status === "fulfilled") setOperations(results[0].value);
    if (results[1].status === "fulfilled") setAlerts(results[1].value);
    if (results[2].status === "fulfilled") setRules(results[2].value);
    if (results[3].status === "fulfilled") setOverview(results[3].value);
    setOperationsError(failures.length ? errorHelp(errorMessage(failures[0].reason)) : "");
  }, [onUnauthorized]);

  useEffect(() => {
    if (authenticated) {
      void loadSources();
      void loadOperations();
      return;
    }
    // Signed out (or not yet known): forget the old session's data and ignore its late answers.
    sourcesRequest.current += 1;
    operationsRequest.current += 1;
    setGroups(emptied);
    setOperations(EMPTY_OPERATIONS);
    setAlerts(emptied);
    setRules(emptied);
    setOverview(null);
    setSourceError("");
    setOperationsError("");
  }, [authenticated, loadSources, loadOperations]);

  usePolling(() => {
    void loadSources({ background: true });
    void loadOperations({ background: true });
  }, REFRESH_INTERVAL_MS, authenticated);

  /** The source list with each source's anomaly stats from the operations summary. */
  const sources = useMemo<ManagedSource[]>(() => {
    const stats = new Map(operations.sources.map((source) => [source.chat_id, source]));
    return groups.map((group) => {
      const known = stats.get(group.chat_id);
      if (!known) return group;
      return { ...group, consecutive_failures: known.consecutive_failures, new_message_volume: known.new_message_volume };
    });
  }, [groups, operations]);

  const reportOperationsError = useCallback((caught: unknown) => setOperationsError(errorHelp(errorMessage(caught))), []);
  const clearOperationsError = useCallback(() => setOperationsError(""), []);

  return {
    sources,
    alerts,
    rules,
    overview,
    sourceError,
    operationsError,
    loadSources,
    loadOperations,
    reportOperationsError,
    clearOperationsError
  };
}

export type AdminData = ReturnType<typeof useAdminData>;
