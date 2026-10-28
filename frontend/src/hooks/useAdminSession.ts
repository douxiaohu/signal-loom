import { useCallback, useEffect, useState } from "react";

import { ApiError, fetchSession, login, logout } from "../api";
import { errorHelp, errorMessage } from "../utils";
import { useLatest } from "./useLatest";

/**
 * Who is signed in to the admin console. `authenticated` stays null until the
 * server has said whether the cookie still holds a session.
 */
export function useAdminSession() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const current = useLatest(authenticated);

  useEffect(() => {
    let active = true;
    fetchSession()
      .then((session) => { if (active) setAuthenticated(session.authenticated); })
      .catch(() => { if (active) setAuthenticated(false); });
    return () => { active = false; };
  }, []);

  /** Pass every API failure through here: a 401 means the session is gone. */
  const handleUnauthorized = useCallback((caught: unknown) => {
    if (!(caught instanceof ApiError && caught.status === 401)) return;
    if (current.current === true) setLoginError("登录已失效，请重新输入管理密钥。");
    setAuthenticated(false);
  }, [current]);

  const signIn = useCallback(async (apiKey: string) => {
    setLoginLoading(true);
    setLoginError("");
    setLogoutError("");
    try {
      await login(apiKey);
      setAuthenticated(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) setLoginError("尝试次数过多，请稍后再试。");
      else if (caught instanceof ApiError && caught.status === 401) setLoginError("管理密钥无效。");
      else setLoginError("登录服务暂时不可用，请检查网络或服务状态后重试。");
    } finally {
      setLoginLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setLogoutError("");
    try {
      await logout();
      setAuthenticated(false);
    } catch (caught) {
      setLogoutError(`退出失败，当前会话仍保持有效。${errorHelp(errorMessage(caught))}`);
    }
  }, []);

  const clearLogoutError = useCallback(() => setLogoutError(""), []);

  return { authenticated, loginError, loginLoading, logoutError, clearLogoutError, signIn, signOut, handleUnauthorized };
}
