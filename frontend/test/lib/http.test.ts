import { vi } from "vitest";

import { ApiError, itemsOf, request, statusMessage } from "../../src/lib/http";

function respond(body: unknown, init: ResponseInit = {}) {
  const payload = typeof body === "string" || body === null ? body : JSON.stringify(body);
  return Promise.resolve(new Response(payload as BodyInit | null, { status: 200, headers: { "Content-Type": "application/json" }, ...init }));
}

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (caught) {
    expect(caught).toBeInstanceOf(ApiError);
    return caught as ApiError;
  }
  throw new Error("expected the request to fail");
}

describe("request", () => {
  it("returns parsed JSON and sends same-origin credentials", async () => {
    const fetchMock = stubFetch(() => respond({ ok: true }));
    await expect(request<{ ok: boolean }>("/api/x")).resolves.toEqual({ ok: true });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("serialises the body as JSON and sets the content type", async () => {
    const fetchMock = stubFetch(() => respond({}));
    await request("/api/x", { method: "POST", body: { api_key: "k" } });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"api_key":"k"}');
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json");
  });

  it("does not add a content type to body-less writes", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(request<void>("/api/auth/logout", { method: "POST" })).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers).not.toHaveProperty("Content-Type");
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers).has("Content-Type")).toBe(false);
  });

  it("surfaces the server's detail message with the HTTP status", async () => {
    stubFetch(() => respond({ detail: "Too many login attempts" }, { status: 429 }));
    const error = await failure(request("/api/auth/login", { method: "POST", body: {} }));
    expect(error.status).toBe(429);
    expect(error.message).toBe("Too many login attempts");
  });

  it("falls back to a readable message when the error body is not JSON", async () => {
    stubFetch(() => Promise.resolve(new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } })));
    const error = await failure(request("/api/x"));
    expect(error.status).toBe(502);
    expect(error.message).toBe("服务暂时不可用（502）");
    expect(error.message).not.toContain("<html>");
  });

  it("ignores a detail that is not a plain string", async () => {
    stubFetch(() => respond({ detail: [{ msg: "x" }] }, { status: 422 }));
    expect((await failure(request("/api/x"))).message).toBe("请求失败（422）");
  });

  it("turns a non-JSON success response into an error instead of a SyntaxError", async () => {
    stubFetch(() => Promise.resolve(new Response("<html>captive portal</html>", { status: 200 })));
    const error = await failure(request("/api/x"));
    expect(error.status).toBe(200);
    expect(error.message).toBe("服务返回了无法识别的内容");
  });

  it("reports network failures in plain language", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await failure(request("/api/x"));
    expect(error.status).toBe(0);
    expect(error.message).toBe("网络连接失败");
  });

  it("passes other errors through unchanged", async () => {
    const boom = new Error("boom");
    stubFetch(() => Promise.reject(boom));
    await expect(request("/api/x")).rejects.toBe(boom);
  });

  it("times out with a clear message and cancels the underlying request", async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    stubFetch((_url, init) => {
      seenSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        seenSignal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const pending = failure(request("/api/slow", { timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(5_001);
    const error = await pending;
    expect(error.status).toBe(0);
    expect(error.message).toBe("请求超时");
    expect(seenSignal?.aborted).toBe(true);
  });

  it("lets the caller cancel and rethrows the AbortError", async () => {
    stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const controller = new AbortController();
    const pending = request("/api/x", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not even start a request that is already cancelled", async () => {
    const fetchMock = stubFetch((_url, init) => {
      if ((init.signal as AbortSignal).aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
      return respond({});
    });
    const controller = new AbortController();
    controller.abort();
    await expect(request("/api/x", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not leak timers after a successful request", async () => {
    vi.useFakeTimers();
    stubFetch(() => respond({ done: true }));
    await request("/api/x");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("statusMessage", () => {
  it("has text for the statuses the UI can meet", () => {
    expect(statusMessage(401)).toContain("登录");
    expect(statusMessage(404)).toContain("不存在");
    expect(statusMessage(429)).toContain("频繁");
    expect(statusMessage(503)).toBe("服务暂时不可用（503）");
    expect(statusMessage(418)).toBe("请求失败（418）");
  });
});

describe("itemsOf", () => {
  it("never returns null or undefined", () => {
    expect(itemsOf({ items: [1, 2] })).toEqual([1, 2]);
    expect(itemsOf({ items: null })).toEqual([]);
    expect(itemsOf({})).toEqual([]);
    expect(itemsOf(undefined)).toEqual([]);
    expect(itemsOf(null)).toEqual([]);
  });
});
