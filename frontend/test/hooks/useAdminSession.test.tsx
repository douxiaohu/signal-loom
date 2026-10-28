import { act, renderHook, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { useAdminSession } from "../../src/hooks/useAdminSession";
import { ApiError } from "../../src/lib/http";
import { deferred, json, stubFetch } from "./helpers";

function session(authenticated: boolean) {
  return json({ authenticated, expires_at: authenticated ? 1_800_000_000 : null });
}

describe("useAdminSession", () => {
  it("is undecided until the server has answered, then follows the answer", async () => {
    stubFetch((url) => (url.pathname === "/api/session" ? session(true) : undefined));
    const { result } = renderHook(() => useAdminSession());

    expect(result.current.authenticated).toBeNull();
    await waitFor(() => expect(result.current.authenticated).toBe(true));
  });

  it("treats an unreachable session endpoint as signed out", async () => {
    stubFetch((url) => (url.pathname === "/api/session" ? json({ detail: "down" }, 503) : undefined));
    const { result } = renderHook(() => useAdminSession());

    await waitFor(() => expect(result.current.authenticated).toBe(false));
  });

  it.each([
    [401, "管理密钥无效。"],
    [429, "尝试次数过多，请稍后再试。"],
    [503, "登录服务暂时不可用，请检查网络或服务状态后重试。"]
  ])("explains a %i answer to the sign-in", async (status, message) => {
    stubFetch((url) => {
      if (url.pathname === "/api/session") return session(false);
      if (url.pathname === "/api/auth/login") return json({ detail: "x" }, status);
      return undefined;
    });
    const { result } = renderHook(() => useAdminSession());
    await waitFor(() => expect(result.current.authenticated).toBe(false));

    await act(async () => { await result.current.signIn("some-key"); });

    expect(result.current.loginError).toBe(message);
    expect(result.current.authenticated).toBe(false);
    expect(result.current.loginLoading).toBe(false);
  });

  it("signs in, reporting the attempt as loading meanwhile", async () => {
    const login = deferred<Response>();
    stubFetch((url) => {
      if (url.pathname === "/api/session") return session(false);
      if (url.pathname === "/api/auth/login") return login.promise;
      return undefined;
    });
    const { result } = renderHook(() => useAdminSession());
    await waitFor(() => expect(result.current.authenticated).toBe(false));

    let attempt!: Promise<void>;
    act(() => { attempt = result.current.signIn("correct-key"); });
    expect(result.current.loginLoading).toBe(true);

    login.resolve(await session(true));
    await act(async () => { await attempt; });
    expect(result.current.authenticated).toBe(true);
    expect(result.current.loginLoading).toBe(false);
    expect(result.current.loginError).toBe("");
  });

  it("stays signed in and says so when signing out fails", async () => {
    stubFetch((url) => {
      if (url.pathname === "/api/session") return session(true);
      if (url.pathname === "/api/auth/logout") return json({ detail: "service unavailable" }, 503);
      return undefined;
    });
    const { result } = renderHook(() => useAdminSession());
    await waitFor(() => expect(result.current.authenticated).toBe(true));

    await act(async () => { await result.current.signOut(); });

    expect(result.current.authenticated).toBe(true);
    expect(result.current.logoutError).toContain("退出失败，当前会话仍保持有效。");
    act(() => result.current.clearLogoutError());
    expect(result.current.logoutError).toBe("");
  });

  it("signs out", async () => {
    stubFetch((url) => {
      if (url.pathname === "/api/session") return session(true);
      if (url.pathname === "/api/auth/logout") return Promise.resolve(new Response(null, { status: 204 }));
      return undefined;
    });
    const { result } = renderHook(() => useAdminSession());
    await waitFor(() => expect(result.current.authenticated).toBe(true));

    await act(async () => { await result.current.signOut(); });

    expect(result.current.authenticated).toBe(false);
    expect(result.current.logoutError).toBe("");
    expect(result.current.loginError).toBe("");
  });

  it("drops the session and explains why when the API answers 401", async () => {
    stubFetch((url) => (url.pathname === "/api/session" ? session(true) : undefined));
    const { result } = renderHook(() => useAdminSession());
    await waitFor(() => expect(result.current.authenticated).toBe(true));

    act(() => result.current.handleUnauthorized(new ApiError(401, "expired")));

    expect(result.current.authenticated).toBe(false);
    expect(result.current.loginError).toBe("登录已失效，请重新输入管理密钥。");
  });

  it("ignores failures that are not a 401", async () => {
    stubFetch((url) => (url.pathname === "/api/session" ? session(true) : undefined));
    const { result } = renderHook(() => useAdminSession());
    await waitFor(() => expect(result.current.authenticated).toBe(true));

    act(() => {
      result.current.handleUnauthorized(new ApiError(500, "boom"));
      result.current.handleUnauthorized(new Error("network"));
      result.current.handleUnauthorized("401");
    });

    expect(result.current.authenticated).toBe(true);
    expect(result.current.loginError).toBe("");
  });

  it("does not blame an expired session for a 401 that arrives after signing out", async () => {
    stubFetch((url) => {
      if (url.pathname === "/api/session") return session(true);
      if (url.pathname === "/api/auth/logout") return Promise.resolve(new Response(null, { status: 204 }));
      return undefined;
    });
    const { result } = renderHook(() => useAdminSession());
    await waitFor(() => expect(result.current.authenticated).toBe(true));
    await act(async () => { await result.current.signOut(); });

    act(() => result.current.handleUnauthorized(new ApiError(401, "late answer of a request from before")));

    expect(result.current.authenticated).toBe(false);
    expect(result.current.loginError).toBe("");
  });

  it("keeps a stable handleUnauthorized across renders", async () => {
    stubFetch((url) => (url.pathname === "/api/session" ? session(true) : undefined));
    const { result } = renderHook(() => useAdminSession());
    const first = result.current.handleUnauthorized;
    await waitFor(() => expect(result.current.authenticated).toBe(true));
    expect(result.current.handleUnauthorized).toBe(first);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
