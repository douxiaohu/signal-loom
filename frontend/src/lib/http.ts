/**
 * The one place that talks to the backend over fetch.
 *
 * Everything the UI needs from a failed request is on ApiError: the HTTP status
 * (0 when the request never produced one) and a message that is already fit to
 * show to a person. Callers never have to parse a response body or guess what a
 * bare "TypeError: Failed to fetch" means.
 */

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Serialised as JSON; the Content-Type header is added for you. */
  body?: unknown;
  /** Cancels the request. The AbortError is passed through untouched. */
  signal?: AbortSignal;
  /** Gives up after this long with an ApiError(0, "请求超时"). Default 30 s. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const headers = new Headers();
  const init: RequestInit = { method, credentials: "same-origin", headers };
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(body);
  }

  // One controller serves both the caller's signal and our timeout, so the
  // reason for an abort can be told apart afterwards.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }
  init.signal = controller.signal;

  try {
    const response = await fetch(url, init);
    if (!response.ok) throw new ApiError(response.status, await failureMessage(response));
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      // A 200 that is not JSON usually means a proxy or captive portal answered.
      throw new ApiError(response.status, "服务返回了无法识别的内容");
    }
  } catch (caught) {
    if (caught instanceof ApiError) throw caught;
    if (timedOut) throw new ApiError(0, "请求超时");
    // The browser reports every network failure as a bare TypeError.
    if (caught instanceof TypeError) throw new ApiError(0, "网络连接失败");
    throw caught;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/** The server's {"detail": "..."} when there is one, else a message for the status. */
async function failureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail.trim()) return body.detail;
  } catch {
    // not JSON: fall through to the generic text
  }
  return statusMessage(response.status);
}

export function statusMessage(status: number): string {
  switch (status) {
    case 400:
      return "请求无效";
    case 401:
      return "登录已失效，请重新登录";
    case 403:
      return "请求被拒绝";
    case 404:
      return "内容不存在或未公开";
    case 413:
      return "提交的内容过大";
    case 429:
      return "请求过于频繁，请稍后再试";
    default:
      return status >= 500 ? `服务暂时不可用（${status}）` : `请求失败（${status}）`;
  }
}

/** Lists come back as {"items": [...]}; a missing or null array becomes []. */
export function itemsOf<T>(payload: { items?: T[] | null } | null | undefined): T[] {
  return payload?.items ?? [];
}
