import type { GithubAdminStatus } from "../types";
import { formatCount, formatDate } from "../utils";

export default function AdminGithub({
  data,
  busy,
  onRefresh
}: {
  data: GithubAdminStatus | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  if (!data) return <p className="empty-copy">正在加载 GitHub 状态…</p>;
  return (
    <div className="admin-stack">
      <header className="admin-page-head">
        <div>
          <h1>GitHub / AI</h1>
          <p>榜单采集和中文解读状态。解读失败不会中断排行采集。</p>
        </div>
        <button className="primary-button" type="button" disabled={busy || data.refreshing} onClick={onRefresh}>
          {busy || data.refreshing ? "正在刷新…" : "立即刷新榜单"}
        </button>
      </header>
      <section className="stat-grid">
        <div className="stat-card"><span>采集开关</span><strong>{data.enabled ? "开启" : "关闭"}</strong><small>状态 {data.collection.status}</small></div>
        <div className="stat-card"><span>AI 解读</span><strong>{data.ai_enabled ? "开启" : "关闭"}</strong><small>{data.ai_model || "未配置模型"}</small></div>
        <div className="stat-card"><span>已翻译</span><strong>{formatCount(data.translated_count)} / {formatCount(data.repository_count)}</strong><small>待翻译 {formatCount(data.pending_count)}</small></div>
        <div className="stat-card"><span>上次采集</span><strong>{data.collection.finished_at ? formatDate(data.collection.finished_at) : "尚无"}</strong><small>抓取 {data.collection.fetched_count} · 入库 {data.collection.saved_count}</small></div>
      </section>
      {data.collection.error ? <div className="inline-error"><strong>最近采集错误</strong><span>{data.collection.error}</span></div> : null}
      <section className="ops-card">
        <header><h2>最近完成解读</h2></header>
        {data.recent.length ? (
          <table className="source-table">
            <thead><tr><th>仓库</th><th>语言</th><th>Stars</th><th>模型</th><th>时间</th></tr></thead>
            <tbody>
              {data.recent.map((item) => (
                <tr key={item.full_name}>
                  <td><strong>{item.full_name}</strong></td>
                  <td><small>{item.language || "—"}</small></td>
                  <td><small>{formatCount(item.stars)}</small></td>
                  <td><small>{item.ai_model || "—"}</small></td>
                  <td><small>{item.ai_generated_at ? formatDate(item.ai_generated_at) : "—"}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="empty-copy">还没有中文解读</p>}
      </section>
      <section className="ops-card">
        <header><h2>待翻译仓库</h2></header>
        {data.pending.length ? (
          <table className="source-table">
            <thead><tr><th>仓库</th><th>语言</th><th>Stars</th></tr></thead>
            <tbody>
              {data.pending.map((item) => (
                <tr key={item.full_name}>
                  <td><strong>{item.full_name}</strong></td>
                  <td><small>{item.language || "—"}</small></td>
                  <td><small>{formatCount(item.stars)}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="empty-copy">热门仓库已全部完成解读</p>}
      </section>
    </div>
  );
}
