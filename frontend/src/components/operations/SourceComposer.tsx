import { useState } from "react";

import { useAsyncSubmit } from "../../hooks/useAsyncSubmit";

export default function SourceComposer({ onCreate }: { onCreate: (name: string, sourceUrl: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const { busy, error, submit } = useAsyncSubmit("来源创建失败，请重试。");
  return (
    <details className="rule-composer source-composer">
      <summary>添加公开 Telegram 频道</summary>
      <form
        onSubmit={(event) =>
          submit(event, async () => {
            await onCreate(name, sourceUrl);
            setName("");
            setSourceUrl("");
          })
        }
      >
        <label htmlFor="source-name">来源名称</label><input id="source-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoComplete="off" />
        <label htmlFor="source-url">频道链接</label><input id="source-url" type="url" placeholder="https://t.me/channel" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} required maxLength={300} autoComplete="url" />
        {error ? <p className="form-error">{error}</p> : null}
        <button type="submit" disabled={busy}>{busy ? "正在添加…" : "添加来源（默认不公开）"}</button>
      </form>
    </details>
  );
}
