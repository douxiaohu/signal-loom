import { ApiError, itemsOf, request } from "./lib/http";
import { messagePageParams } from "./lib/filters";
import type { AdminOverview, AlertMatch, AlertRule, Filters, Group, MessagePage, OperationSummary, Session, VisitRecord, VisitStats } from "./types";

export { ApiError };

/** "立即采集" waits for the crawl to finish, which can take a while. */
const CRAWL_TIMEOUT_MS = 120_000;

function withPage(page: MessagePage): MessagePage {
  return { ...page, items: page.items ?? [] };
}

export const fetchSession = () => request<Session>("/api/session");
export const login = (apiKey: string) => request<Session>("/api/auth/login", { method: "POST", body: { api_key: apiKey } });
export const logout = () => request<void>("/api/auth/logout", { method: "POST" });

export async function fetchGroups(signal?: AbortSignal) {
  const data = await request<{ items?: Array<Partial<Group> & Pick<Group, "chat_id" | "name" | "health_status"> & { source_url: string }> | null }>(
    "/api/admin/sources",
    { signal }
  );
  return itemsOf(data).map((source): Group => ({
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

export async function fetchMessages(filters: Filters, options: { cursor?: string; limit: number; signal?: AbortSignal }) {
  const params = messagePageParams(filters, options);
  return withPage(await request<MessagePage>(`/api/admin/messages?${params}`, { signal: options.signal }));
}

export const fetchOperations = async (signal?: AbortSignal): Promise<OperationSummary> => {
  const summary = await request<OperationSummary>("/api/admin/operations/summary", { signal });
  return { ...summary, sources: summary.sources ?? [], unhealthy_sources: summary.unhealthy_sources ?? [] };
};
export const fetchAlerts = async (signal?: AbortSignal) => itemsOf(await request<{ items?: AlertMatch[] | null }>("/api/admin/matches", { signal }));
export const fetchAlertRules = async (signal?: AbortSignal) => itemsOf(await request<{ items?: AlertRule[] | null }>("/api/admin/rules", { signal }));

export const createAlertRule = (payload: { name: string; keyword: string; source_ids: number[] }) =>
  request<AlertRule>("/api/admin/rules", { method: "POST", body: { ...payload, enabled: false } });
export const patchAlertRule = (id: number, payload: Partial<AlertRule>) =>
  request<AlertRule>(`/api/admin/rules/${id}`, { method: "PATCH", body: payload });
export const acknowledgeAlert = (id: number) => request<AlertMatch>(`/api/admin/matches/${id}/acknowledge`, { method: "POST" });
export const resolveAlert = (id: number) => request<AlertMatch>(`/api/admin/matches/${id}/resolve`, { method: "POST" });

export const createSource = (payload: { name: string; source_url: string }) =>
  request<Group>("/api/admin/sources", { method: "POST", body: payload });
export const patchSource = (chatId: number, payload: { name?: string; enabled?: boolean; public_visible?: boolean }) =>
  request<Group>(`/api/admin/sources/${chatId}`, { method: "PATCH", body: payload });
export const crawlSource = (chatId: number) =>
  request<unknown>(`/api/admin/sources/${chatId}/crawl-now`, { method: "POST", timeoutMs: CRAWL_TIMEOUT_MS });

export const fetchOverview = (signal?: AbortSignal) => request<AdminOverview>("/api/admin/overview", { signal });
export async function fetchVisits(signal?: AbortSignal) {
  const payload = await request<{ items?: VisitRecord[] | null; stats: VisitStats }>("/api/admin/visits", { signal });
  return { items: itemsOf(payload), stats: payload.stats };
}
