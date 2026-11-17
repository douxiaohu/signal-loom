import { Button } from "./ui/button";
import { useEffect, useState } from "react";
import { request } from "../lib/http";
type Usage = {
  bytes: number;
  files: number;
  max_bytes: number;
  max_age_days: number;
  removed: number;
};
const size = (bytes: number) =>
  `${(bytes / 1024 / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MiB`;
export default function CachePanel() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [token, setToken] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void request<Usage>("/api/admin/cache", { signal: controller.signal })
      .then(setUsage)
      .catch(() => {
        if (!controller.signal.aborted) setError("缓存统计加载失败");
      });
    return () => controller.abort();
  }, [token]);
  async function prune() {
    setBusy(true);
    setError("");
    try {
      const result = await request<Usage>("/api/admin/cache/prune", {
        method: "POST",
        body: {},
        timeoutMs: 120000,
      });
      setUsage(result);
      setStatus(`已清理 ${result.removed} 个缓存文件`);
    } catch {
      setError("清理失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="admin-stack">
      <header className="admin-page-head">
        <div>
          <h1>缓存空间</h1>
          <p>
            按容量与最近使用时间清理媒体缓存。消息记录始终保留；原媒体仍可访问时会按需重新下载。
          </p>
        </div>
      </header>
      {error && (
        <div className="pub-notice" role="alert">
          {error}
          <button
            onClick={() => {
              setError("");
              setToken((n) => n + 1);
            }}
          >
            重试
          </button>
        </div>
      )}
      {usage && (
        <div className="stat-grid">
          <div className="stat-card">
            <span>缓存占用</span>
            <strong>{size(usage.bytes)}</strong>
            <small>容量上限 {size(usage.max_bytes)}</small>
          </div>
          <div className="stat-card">
            <span>缓存文件</span>
            <strong>{usage.files}</strong>
            <small>包括原图、缩略图与视频</small>
          </div>
          <div className="stat-card">
            <span>保留时长</span>
            <strong>{usage.max_age_days} 天</strong>
            <small>启动时及每 15 分钟自动检查</small>
          </div>
        </div>
      )}
      <div className="ops-card cache-maintenance">
        <h2>立即执行维护</h2>
        <p>
          移除超龄文件，并在超过总容量时优先清理较久未使用的缓存。不会删除数据库消息。
        </p>
        <Button
          type="button"
          disabled={busy || !usage}
          onClick={() => void prune()}
        >
          {busy ? "正在清理…" : "清理缓存"}
        </Button>
        <p role="status">{status}</p>
      </div>
    </section>
  );
}
