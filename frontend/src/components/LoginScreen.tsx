import { FormEvent, useEffect, useRef, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";

import ShinyText from "../bits/ShinyText";
import SpotlightCard from "../bits/SpotlightCard";
import StarBorder from "../bits/StarBorder";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
      <SpotlightCard as={Card} role="region" className="login-panel" aria-labelledby="login-title">
        <div className="login-brand" aria-hidden="true"><ShieldCheck size={26} /></div>
        <p className="eyebrow">管理入口</p>
        <h1 id="login-title"><ShinyText text="管理中心" /></h1>
        <p className="login-copy">此后台与前台阅读页分离，不在公开页露出入口。用管理密钥建立 12 小时会话，密钥不会写入浏览器存储。</p>
        <form onSubmit={submit}>
          <label htmlFor="admin-key">管理密钥</label>
          <div className="key-field">
            <KeyRound size={18} aria-hidden="true" />
            <Input
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
          <StarBorder
            as="button"
            className="primary-button login-submit"
            type="submit"
            color="var(--admin-brand)"
            backgroundColor="var(--admin-brand)"
            textColor="var(--admin-on-brand)"
            speed="5s"
            disabled={loading}
          >
            {loading ? "正在验证…" : "进入管理中心"}
          </StarBorder>
        </form>
        <p className="login-note">会话 Cookie 为 HttpOnly、SameSite=Strict；生产环境仅通过 HTTPS 发送。</p>
      </SpotlightCard>
    </main>
  );
}
