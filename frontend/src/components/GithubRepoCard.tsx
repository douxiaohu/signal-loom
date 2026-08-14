import type { GithubPeriod, GithubRepository } from "../types";
import { formatCount, languageHue } from "../utils";

const periodLabels: Record<GithubPeriod, string> = {
  daily: "24 小时",
  weekly: "7 天",
  monthly: "30 天"
};

export default function GithubRepoCard({ repository, period }: { repository: GithubRepository; period: GithubPeriod }) {
  const hasAiExplanation = Boolean(repository.ai_summary_zh && repository.ai_problem_zh);
  const languageBreakdown = repository.language_breakdown || [];
  const rankClass = repository.rank <= 3 ? ` repo-rank-top${repository.rank}` : "";
  return (
    <article className="repo-row">
      <div className={`repo-rank${rankClass}`} aria-label={`第 ${repository.rank} 名`}>{repository.rank}</div>
      <div className="repo-main">
        <div className="repo-path">
          <span>{repository.owner}</span><b>/</b><strong>{repository.name}</strong>
        </div>
        <p className="repo-summary">{repository.ai_summary_zh || repository.description || "该仓库暂未填写项目简介。"}</p>
        {hasAiExplanation || languageBreakdown.length || repository.topics.length ? (
          <details className="repo-details">
            <summary>解读与特征</summary>
            {hasAiExplanation ? (
              <>
                <p><b>项目意义</b>{repository.ai_significance_zh}</p>
                <p><b>解决问题</b>{repository.ai_problem_zh}</p>
              </>
            ) : null}
            {languageBreakdown.length ? (
              <>
                <p><b>语言构成</b>{languageBreakdown.slice(0, 5).map((item) => `${item.language} ${item.percentage}%`).join(" · ")}</p>
                <div className="lang-bar" aria-hidden="true">
                  {languageBreakdown.slice(0, 5).map((item) => (
                    <span
                      key={item.language}
                      style={{ width: `${item.percentage}%`, background: `hsl(${languageHue(item.language)} 60% 52%)` }}
                    />
                  ))}
                </div>
              </>
            ) : null}
            {repository.topics.length ? (
              <div className="repo-topics">
                {repository.language ? <span>{repository.language}</span> : null}
                {repository.license ? <span>{repository.license}</span> : null}
                {repository.topics.slice(0, 5).map((topic) => <span key={topic}>#{topic}</span>)}
              </div>
            ) : null}
          </details>
        ) : null}
      </div>
      <div className="repo-meta">
        <span className="repo-delta">
          {repository.history_complete ? `${periodLabels[period]} +${formatCount(repository.stars_delta)} stars` : "建立增长基线中"}
        </span>
        <span>{repository.language || "语言未知"} · ★ {formatCount(repository.stars)}</span>
        <a className="repo-out" href={repository.html_url} target="_blank" rel="noreferrer">GitHub</a>
      </div>
    </article>
  );
}
