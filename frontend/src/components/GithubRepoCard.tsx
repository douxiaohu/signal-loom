import type { GithubPeriod, GithubRepository } from "../types";
import { formatCount, formatDate } from "../utils";


const periodLabels: Record<GithubPeriod, string> = {
  daily: "24 小时",
  weekly: "7 天",
  monthly: "30 天"
};


export default function GithubRepoCard({ repository, period }: { repository: GithubRepository; period: GithubPeriod }) {
  const hasAiExplanation = Boolean(repository.ai_summary_zh && repository.ai_problem_zh);
  const languageBreakdown = repository.language_breakdown || [];
  return (
    <article className="github-repo-card">
      <div className={`github-rank rank-${Math.min(repository.rank, 4)}`} aria-label={`第 ${repository.rank} 名`}>
        <span>#</span>{repository.rank}
      </div>
      <div className="github-repo-main">
        <header className="github-repo-head">
          <div>
            <div className="repo-path"><span>{repository.owner}</span><b>/</b><strong>{repository.name}</strong></div>
            <p>{repository.ai_summary_zh || repository.description || "该仓库暂未填写项目简介。"}</p>
          </div>
          <a href={repository.html_url} target="_blank" rel="noreferrer" aria-label={`在 GitHub 打开 ${repository.full_name}`}>
            <span aria-hidden="true">↗</span>
          </a>
        </header>
        {hasAiExplanation ? (
          <section className="repo-ai-summary" aria-label={`${repository.full_name} AI 项目解读`}>
            <strong><i aria-hidden="true" />AI 中文解读</strong>
            <p><b>项目意义</b>{repository.ai_significance_zh}</p>
            <p><b>解决问题</b>{repository.ai_problem_zh}</p>
          </section>
        ) : null}
        {languageBreakdown.length ? (
          <p className="repo-language-composition"><b>语言构成</b>{languageBreakdown.slice(0, 5).map((item) => `${item.language} ${item.percentage}%`).join(" · ")}</p>
        ) : null}
        <div className="repo-feature-row">
          {repository.language ? <span className="repo-language"><i aria-hidden="true" />{repository.language}</span> : null}
          {repository.license ? <span>{repository.license}</span> : null}
          {repository.topics.slice(0, 5).map((topic) => <span key={topic}>#{topic}</span>)}
        </div>
        <footer className="github-repo-foot">
          <div className="repo-counters">
            <span title="Stars"><i aria-hidden="true">★</i>{formatCount(repository.stars)}</span>
            <span title="Forks"><i aria-hidden="true">⑂</i>{formatCount(repository.forks)}</span>
            <span title="Open issues"><i aria-hidden="true">○</i>{formatCount(repository.open_issues)}</span>
            <span title="最近推送"><i aria-hidden="true">◷</i>{repository.pushed_at ? formatDate(repository.pushed_at) : "暂无推送"}</span>
          </div>
          <div className="repo-velocity">
            <i className="repo-pulse" aria-hidden="true" />
            <span>{repository.history_complete ? `${periodLabels[period]} +${formatCount(repository.stars_delta)} stars` : "建立增长基线中"}</span>
            <strong>{repository.activity_score.toFixed(1)}</strong>
          </div>
        </footer>
      </div>
    </article>
  );
}
