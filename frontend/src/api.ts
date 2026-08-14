import type { AdminOverview, AlertMatch, AlertRule, Filters, GithubAdminStatus, Group, MessagePage, OperationSummary, Session, VisitRecord, VisitStats } from "./types";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, credentials: "same-origin", headers });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`.trim();
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // Keep the HTTP fallback when the response is not JSON.
    }
    throw new ApiError(response.status, detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const fetchSession = () => apiFetch<Session>("/api/session");
export const login = (apiKey: string) => apiFetch<Session>("/api/auth/login", { method: "POST", body: JSON.stringify({ api_key: apiKey }) });
export const logout = () => apiFetch<void>("/api/auth/logout", { method: "POST" });

export async function fetchGroups(signal?: AbortSignal) {
  const data = await apiFetch<{ items: Array<Partial<Group> & Pick<Group, "chat_id" | "name" | "health_status"> & { source_url: string }> }>("/api/admin/sources", { signal });
  return data.items.map((source): Group => ({
    chat_id: source.chat_id,
    name: source.name,
    source: source.source_url,
    source_url: source.source_url,
    source_type: source.source_type || "public",
    enabled: source.enabled ?? true,
    public_visible: source.public_visible ?? false,
    message_count: source.message_count || 0,
    last_message_time: source.last_message_time || null,
    health_status: source.health_status,
    last_run_at: source.last_run_at || null,
    last_success_at: source.last_success_at || null,
    last_error: source.last_error || null,
    fetched_count: source.fetched_count || 0,
    saved_count: source.saved_count || 0
  }));
}

export function fetchMessages(filters: Filters, options: { cursor?: string; limit: number; signal?: AbortSignal }) {
  const params = new URLSearchParams({ limit: String(options.limit), media: filters.media });
  if (options.cursor) params.set("cursor", options.cursor);
  if (filters.chatId !== "all") params.set("chat_id", filters.chatId);
  if (filters.query.trim()) params.set("query", filters.query.trim());
  return apiFetch<MessagePage>(`/api/admin/messages?${params}`, { signal: options.signal });
}

export const fetchOperations = (signal?: AbortSignal) => apiFetch<OperationSummary>("/api/admin/operations/summary", { signal });
export const fetchAlerts = (signal?: AbortSignal) => apiFetch<{ items: AlertMatch[] }>("/api/admin/matches", { signal }).then((data) => data.items);
export const fetchAlertRules = (signal?: AbortSignal) => apiFetch<{ items: AlertRule[] }>("/api/admin/rules", { signal }).then((data) => data.items);

export const createAlertRule = (payload: { name: string; keyword: string; source_ids: number[] }) =>
  apiFetch<AlertRule>("/api/admin/rules", { method: "POST", body: JSON.stringify({ ...payload, enabled: false }) });
export const patchAlertRule = (id: number, payload: Partial<AlertRule>) =>
  apiFetch<AlertRule>(`/api/admin/rules/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const acknowledgeAlert = (id: number) => apiFetch<AlertMatch>(`/api/admin/matches/${id}/acknowledge`, { method: "POST" });
export const resolveAlert = (id: number) => apiFetch<AlertMatch>(`/api/admin/matches/${id}/resolve`, { method: "POST" });

export const createSource = (payload: { name: string; source_url: string }) =>
  apiFetch<Group>("/api/admin/sources", { method: "POST", body: JSON.stringify(payload) });
export const patchSource = (chatId: number, payload: { name?: string; enabled?: boolean; public_visible?: boolean }) =>
  apiFetch<Group>(`/api/admin/sources/${chatId}`, { method: "PATCH", body: JSON.stringify(payload) });
export const crawlSource = (chatId: number) => apiFetch<unknown>(`/api/admin/sources/${chatId}/crawl-now`, { method: "POST" });
export const fetchOverview = (signal?: AbortSignal) => apiFetch<AdminOverview>("/api/admin/overview", { signal });
export const fetchVisits = (signal?: AbortSignal) => apiFetch<{ items: VisitRecord[]; stats: VisitStats }>("/api/admin/visits", { signal });
export const fetchGithubStatus = (signal?: AbortSignal) => apiFetch<GithubAdminStatus>("/api/admin/github/status", { signal });
export const refreshGithub = () => apiFetch<unknown>("/api/admin/github/refresh", { method: "POST" });
