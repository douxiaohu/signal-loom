import { FormEvent, useEffect, useRef, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { ThemeSwitcher } from "../theme";

type LoginScreenProps = {
  error: string;
  loading: boolean;
  onLogin: (apiKey: string) => Promise<void>;
};

export default function LoginScreen({ error, loading, onLogin }: LoginScreenProps) {
  const [apiKey, setApiKey] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onLogin(apiKey);
  }

  return (
    <main className="login-shell">
      <div className="login-theme"><ThemeSwitcher /></div>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand" aria-hidden="true"><ShieldCheck size={28} /></div>
        <p className="eyebrow">PRIVATE OPERATIONS</p>
        <h1 id="login-title">频道监测管理中心</h1>
        <p className="login-copy">管理员可维护频道来源、采集状态和监测规则。使用管理密钥建立 12 小时私有会话，密钥不会写入浏览器存储。</p>
        <form onSubmit={submit}>
          <label htmlFor="admin-key">管理密钥</label>
          <div className="key-field">
            <KeyRound size={18} aria-hidden="true" />
            <input
              id="admin-key"
              type="password"
              name="admin_key"
              autoComplete="current-password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              spellCheck={false}
              required
              maxLength={256}
            />
          </div>
          {error ? <p className="form-error" ref={errorRef} tabIndex={-1} aria-live="polite">{error}</p> : null}
          <button className="primary-button" type="submit" disabled={loading}>
            {loading ? "正在验证…" : "进入管理中心"}
          </button>
        </form>
        <p className="login-note">会话 Cookie 为 HttpOnly、SameSite=Strict；生产环境仅通过 HTTPS 发送。</p>
      </section>
    </main>
  );
}
