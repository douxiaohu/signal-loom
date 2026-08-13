import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import GithubApp from "../src/GithubApp";


function response(period = "daily") {
  return Promise.resolve(new Response(JSON.stringify({
    items: [{
      id: 1, rank: 1, full_name: "acme/rocket", owner: "acme", name: "rocket",
      description: "Fast API agent toolkit", html_url: "https://github.com/acme/rocket",
      homepage: "", language: "Python", topics: ["fastapi", "agents"], license: "MIT",
      language_breakdown: [
        { language: "Python", bytes: 8200, percentage: 82 },
        { language: "TypeScript", bytes: 1800, percentage: 18 }
      ],
      features: {}, ai_summary_zh: "用于构建 FastAPI 智能体服务的工具包。",
      ai_significance_zh: "降低智能体后端的工程化门槛。",
      ai_problem_zh: "解决智能体 API 编排、接入和复用成本高的问题。",
      ai_generated_at: "2026-08-06T01:05:00Z",
      stars: 125, forks: 24, open_issues: 8, watchers: 125,
      stars_delta: 25, forks_delta: 4, issues_delta: 3, activity_score: 145.5,
      history_complete: true, baseline_at: "2026-08-05T00:00:00Z",
      created_at: "2025-01-01T00:00:00Z", updated_at: "2026-08-06T00:00:00Z",
      pushed_at: "2026-08-06T00:00:00Z", collected_at: "2026-08-06T01:00:00Z"
    }],
    total: 1, page: 1, per_page: 24, has_more: false, period,
    cutoff: "2026-08-05T00:00:00Z",
    languages: [{ language: "Python", repository_count: 1 }],
    collection: { status: "succeeded", last_updated: "2026-08-06T01:00:00Z", next_refresh: null, repository_count: 1, refreshing: false, history_days: 1 }
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
}


describe("GithubApp", () => {
  it("renders and switches period rankings", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      return response(url.searchParams.get("period") || "daily");
    }));
    const user = userEvent.setup();

    render(<GithubApp />);

    expect(await screen.findByRole("heading", { name: "找到正在加速的开源项目" })).toBeInTheDocument();
    expect(await screen.findByText("用于构建 FastAPI 智能体服务的工具包。")).toBeInTheDocument();
    expect(screen.getByText("降低智能体后端的工程化门槛。")).toBeInTheDocument();
    expect(screen.getByText("解决智能体 API 编排、接入和复用成本高的问题。")).toBeInTheDocument();
    expect(screen.getByText("Python 82% · TypeScript 18%")).toBeInTheDocument();
    expect(screen.getByText("24 小时 +25 stars")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "频道资讯" })).toHaveAttribute("href", "/");

    await user.click(screen.getByRole("button", { name: /周榜/ }));

    expect(await screen.findByText("7 天 +25 stars")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("period=weekly"))).toBe(true);
  });
});
