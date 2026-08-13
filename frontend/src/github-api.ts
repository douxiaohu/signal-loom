import type { GithubPeriod, GithubRankingResponse, GithubSort } from "./types";


export type GithubFilters = {
  period: GithubPeriod;
  language: string;
  query: string;
  sort: GithubSort;
};


export async function fetchGithubRankings(
  filters: GithubFilters,
  options: { page?: number; perPage?: number; signal?: AbortSignal } = {}
) {
  const params = new URLSearchParams({
    period: filters.period,
    sort: filters.sort,
    page: String(options.page || 1),
    per_page: String(options.perPage || 24)
  });
  if (filters.language) params.set("language", filters.language);
  if (filters.query.trim()) params.set("query", filters.query.trim());
  const response = await fetch(`/api/public/github/rankings?${params}`, {
    signal: options.signal,
    credentials: "same-origin"
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  return (await response.json()) as GithubRankingResponse;
}
