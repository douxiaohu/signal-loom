import { expect, test, type Page, type Route } from "@playwright/test";

const groups = [
  {
    chat_id: -1001, name: "安全情报源", source: "https://t.me/security", source_url: "https://t.me/security", source_type: "telegram_public",
    enabled: true, public_visible: true, message_count: 18, pending_count: 0, last_message_time: "2026-07-13T08:10:00+00:00",
    health_status: "healthy", last_run_at: "2026-07-13T08:11:00+00:00", last_success_at: "2026-07-13T08:11:00+00:00",
    last_error: null, fetched_count: 22, saved_count: 3
  },
  {
    chat_id: -1002, name: "行业动态频道", source: "https://t.me/industry", source_url: "https://t.me/industry", source_type: "telegram_public",
    enabled: true, public_visible: true, message_count: 9, pending_count: 0, last_message_time: "2026-07-13T07:50:00+00:00",
    health_status: "stale", last_run_at: "2026-07-13T07:10:00+00:00", last_success_at: "2026-07-13T07:10:00+00:00",
    last_error: null, fetched_count: 8, saved_count: 1
  }
];

const messages = [
  {
    id: 2, chat_id: -1001, chat_title: "安全情报源", message_id: 102, sender_name: "值班员",
    message_time: "2026-07-13T08:10:00+00:00", content: "供应链组件出现高危漏洞，请优先确认受影响版本。",
    media_type: "photo", media_urls: ["/api/public/media/2/0?variant=thumbnail"],
    media_items: [{ url: "/api/public/media/2/0?variant=thumbnail", original_url: "/api/public/media/2/0?variant=original", kind: "photo", role: "media" }],
    source_url: "https://t.me/security/102"
  },
  {
    id: 1, chat_id: -1002, chat_title: "行业动态频道", message_id: 88, sender_name: "编辑",
    message_time: "2026-07-13T07:50:00+00:00", content: "频道资讯聚合样例。",
    media_type: null, media_urls: [], media_items: [], source_url: "https://t.me/industry/88"
  }
];

async function installApi(page: Page, startAuthenticated = true) {
  let authenticated = startAuthenticated;
  const requestedPaths: string[] = [];
  await page.exposeFunction("requestedApiPaths", () => requestedPaths);
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    requestedPaths.push(path);
    if (path === "/api/session") return json(route, { authenticated, expires_at: authenticated ? "2026-07-14T06:00:00+00:00" : null });
    if (path === "/api/auth/login") { authenticated = true; return json(route, { authenticated: true, expires_at: "2026-07-14T06:00:00+00:00" }); }
    if (path === "/api/auth/logout") return route.fulfill({ status: 204 });
    if (path === "/api/public/sources") return json(route, { items: groups.map(({ source_url, ...source }) => ({ ...source, source_url })) });
    if (path === "/api/public/messages") return json(route, { items: messages, has_more: false, next_cursor: null, total: null });
    if (path === "/api/public/github/rankings") return json(route, {
      items: [{
        id: 1, rank: 1, full_name: "acme/rocket", owner: "acme", name: "rocket",
        description: "Fast API agent toolkit", html_url: "https://github.com/acme/rocket", homepage: "",
        language: "Python", language_breakdown: [
          { language: "Python", bytes: 8200, percentage: 82 },
          { language: "TypeScript", bytes: 1800, percentage: 18 }
        ], topics: ["fastapi", "agents"], license: "MIT", features: {},
        ai_summary_zh: "用于构建 FastAPI 智能体服务的工具包。",
        ai_significance_zh: "降低智能体后端的工程化门槛。",
        ai_problem_zh: "解决智能体 API 编排、接入和复用成本高的问题。",
        ai_generated_at: "2026-08-06T01:05:00Z", stars: 125, forks: 24, open_issues: 8, watchers: 125,
        stars_delta: 25, forks_delta: 4, issues_delta: 3, activity_score: 145.5, history_complete: true,
        baseline_at: "2026-08-05T00:00:00Z", created_at: "2025-01-01T00:00:00Z",
        updated_at: "2026-08-06T00:00:00Z", pushed_at: "2026-08-06T00:00:00Z", collected_at: "2026-08-06T01:00:00Z"
      }],
      total: 1, page: 1, per_page: 24, has_more: false, period: "daily", cutoff: "2026-08-05T00:00:00Z",
      languages: [{ language: "Python", repository_count: 1 }],
      collection: { status: "succeeded", last_updated: "2026-08-06T01:00:00Z", next_refresh: null, repository_count: 1, refreshing: false, history_days: 1 }
    });
    if (path === "/api/admin/sources") return json(route, { items: groups });
    if (path === "/api/admin/overview") return json(route, {
      visits: { total: 12, unique_ips: 4, today: 3, today_unique: 2, last_24h: 3, last_7d_unique: 4 },
      sources: { total: 2, enabled: 2, public: 2, unhealthy: 1, items: groups },
      github: { enabled: true, ai_enabled: false, ai_model: "", refreshing: false, repository_count: 1, translated_count: 1, pending_count: 0, last_ai_at: "2026-08-06T01:05:00Z", pending: [], recent: [], collection: { status: "succeeded", started_at: "2026-08-06T01:00:00Z", finished_at: "2026-08-06T01:01:00Z", fetched_count: 1, saved_count: 1, error: null, rate_limit_remaining: 5000 } },
      alerts: { new_count: 1 }
    });
    if (path === "/api/admin/visits") return json(route, { items: [], stats: { total: 12, unique_ips: 4, today: 3, today_unique: 2, last_24h: 3, last_7d_unique: 4 } });
    if (path === "/api/admin/github/status") return json(route, { enabled: true, ai_enabled: false, ai_model: "", refreshing: false, repository_count: 1, translated_count: 1, pending_count: 0, last_ai_at: null, pending: [], recent: [], collection: { status: "succeeded", started_at: null, finished_at: null, fetched_count: 0, saved_count: 0, error: null, rate_limit_remaining: null } });
    if (path === "/api/admin/messages") return json(route, { items: messages, has_more: false, next_cursor: null, total: null });
    if (path === "/api/admin/operations/summary") return json(route, { sources: groups, unhealthy_sources: [groups[1]], public_source_count: 2, source_count: 2 });
    if (path === "/api/admin/matches") return json(route, { items: [{ id: 1, rule_id: 1, rule_name: "高危漏洞", keyword: "漏洞", status: "new", matched_at: "2026-07-13T08:10:00+00:00", chat_title: "安全情报源", sender_name: "值班员", message_time: "2026-07-13T08:10:00+00:00", content: "供应链组件出现高危漏洞", media_type: "photo" }] });
    if (path === "/api/admin/rules") return json(route, { items: [{ id: 1, name: "高危漏洞", keyword: "漏洞", media_type: null, quiet_start: null, quiet_end: null, cooldown_minutes: 30, enabled: true, source_ids: [], created_at: "", updated_at: "" }] });
    if (path.startsWith("/api/admin/matches/") || path.startsWith("/api/admin/rules/") || path.startsWith("/api/admin/sources/")) return json(route, {});
    if (path.includes("/media/")) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="800"><rect width="2400" height="800" fill="#17455d"/><circle cx="1200" cy="400" r="260" fill="#64e5f2"/></svg>' });
    return route.fulfill({ status: 404 });
  });
}

test("public platform is keyless, responsive, keyboard reachable and WebGL-free", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "WebGLRenderingContext", { configurable: true, value: undefined });
    Object.defineProperty(window, "WebGL2RenderingContext", { configurable: true, value: undefined });
  });
  await installApi(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "频道资讯" })).toBeVisible();
  await expect(page.getByText("供应链组件出现高危漏洞，请优先确认受影响版本。")) .toBeVisible();
  await expect(page.getByLabel("管理密钥")).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const paths = await page.evaluate(async () => await (window as unknown as { requestedApiPaths: () => Promise<string[]> }).requestedApiPaths());
  expect(paths).not.toContain("/api/session");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "跳到消息列表" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#message-list")).toBeFocused();

  await page.getByLabel("搜索消息关键词").fill("高危");
  await page.getByRole("button", { name: "搜索" }).click();
  await expect(page).toHaveURL(/query=%E9%AB%98%E5%8D%B1/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("public image is contained and opens a full-image viewer", async ({ page }) => {
  await installApi(page);
  await page.goto("/");
  const image = page.getByRole("img", { name: /安全情报源.*图片/ });
  await expect(image).toBeVisible();
  expect(await image.evaluate((node) => getComputedStyle(node).objectFit)).toBe("contain");
  await page.getByRole("button", { name: "查看完整图片 1" }).click();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "图片预览" })).toHaveCount(0);
});

test("GitHub ranking explains project value, problem and language composition", async ({ page }) => {
  await installApi(page);
  await page.goto("/github/");
  await expect(page.getByText("用于构建 FastAPI 智能体服务的工具包。")).toBeVisible();
  await page.getByText("解读与特征").click();
  await expect(page.getByText("降低智能体后端的工程化门槛。")).toBeVisible();
  await expect(page.getByText("解决智能体 API 编排、接入和复用成本高的问题。")).toBeVisible();
  await expect(page.getByText("Python 82% · TypeScript 18%")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("admin center keeps key login and contains no delivery surface", async ({ page }) => {
  await installApi(page, false);
  await page.goto("/admin/");
  await expect(page.getByRole("heading", { name: "管理中心" })).toBeVisible();
  await page.getByLabel("管理密钥").fill("test-management-key");
  await page.getByRole("button", { name: "进入管理中心" }).click();
  await expect(page.getByRole("heading", { name: "管理中心" })).toBeVisible();
  await page.getByRole("button", { name: "来源采集" }).click();
  await expect(page.getByRole("heading", { name: "来源管理" })).toBeVisible();
  await expect(page.getByText("可靠投递")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("paper theme keeps the admin media filter readable", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("tm-theme", "paper"));
  await installApi(page);
  await page.goto("/admin/");
  await expect(page.getByRole("heading", { name: "管理中心" })).toBeVisible();
  await page.getByRole("button", { name: "消息检索" }).click();

  const mediaFilter = page.getByLabel("媒体类型");
  if ((page.viewportSize()?.width || 0) <= 1180) {
    await page.locator(".timeline-toolbar").getByRole("button", { name: "筛选" }).click();
  }
  await expect(mediaFilter).toBeVisible();
  await expect(mediaFilter).toHaveValue("all");
  const colors = await mediaFilter.evaluate((node) => {
    const style = getComputedStyle(node);
    const channels = (value: string) => {
      const values = value.match(/[\d.]+/g)?.map(Number) || [];
      return value.startsWith("color(srgb") ? values.slice(0, 3).map((item) => item * 255) : values.slice(0, 3);
    };
    const luminance = (value: string) => {
      const [red, green, blue] = channels(value).map((item) => {
        const channel = item / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return {
      background: style.backgroundColor,
      color: style.color,
      contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
    };
  });

  expect(colors.background).toBe("rgb(27, 34, 43)");
  expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
});

test("dark themes keep inverted controls readable", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("tm-theme", "midnight"));
  await installApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "频道资讯" })).toBeVisible();
  for (const selector of [".site-nav a.active", ".media-chip.active", ".site-search button"]) {
    const colors = await elementColors(page.locator(selector).first());
    expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
  }
  await page.goto("/github/");
  await expect(page.getByRole("heading", { name: "GitHub 趋势" })).toBeVisible();
  const periodColors = await elementColors(page.locator(".period-switch button.active"));
  expect(periodColors.contrast).toBeGreaterThanOrEqual(4.5);
});

test("admin message cards follow the console surface", async ({ page }) => {
  await installApi(page);
  await page.goto("/admin/");
  await expect(page.getByRole("heading", { name: "管理中心" })).toBeVisible();
  await page.getByRole("button", { name: "消息检索" }).click();
  const card = page.locator(".message-card.is-console").first();
  await expect(card).toBeVisible();
  const surfaces = await card.evaluate((node) => {
    const style = getComputedStyle(node);
    const column = getComputedStyle(node.closest(".timeline-column") as HTMLElement);
    return { cardBg: style.backgroundColor, columnBg: column.backgroundColor };
  });
  expect(surfaces.cardBg).not.toBe("rgb(255, 255, 255)");
  expect(surfaces.cardBg).toBe(surfaces.columnBg);
});

test("github toolbar stays on one line on desktop", async ({ page }, testInfo) => {
  test.skip((testInfo.project.use.viewport as { width: number }).width < 1000, "desktop layout only");
  await installApi(page);
  await page.goto("/github/");
  await expect(page.getByText("用于构建 FastAPI 智能体服务的工具包。")).toBeVisible();
  const height = await page.locator(".github-toolbar").evaluate((node) => node.getBoundingClientRect().height);
  expect(height).toBeLessThan(60);
});

test("light theme keeps secondary text readable", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("tm-theme", "paper"));
  await installApi(page);
  await page.goto("/");
  await expect(page.getByText("供应链组件出现高危漏洞，请优先确认受影响版本。")).toBeVisible();
  const colors = await elementColors(page.locator(".day-label").first(), "body");
  expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
});

test("reduced motion stops the admin signal pulse", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installApi(page);
  await page.goto("/admin/");
  await expect(page.getByRole("heading", { name: "管理中心" })).toBeVisible();
  await expect(page.locator(".admin-app")).toBeVisible();
});

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function elementColors(locator: import("@playwright/test").Locator, backgroundSelector = "") {
  return locator.evaluate((node, bgSelector) => {
    const style = getComputedStyle(node);
    const channels = (value: string) => {
      const values = value.match(/[\d.]+/g)?.map(Number) || [];
      return value.startsWith("color(srgb") ? values.slice(0, 3).map((item) => item * 255) : values.slice(0, 3);
    };
    const luminance = (value: string) => {
      const [red, green, blue] = channels(value).map((item) => {
        const channel = item / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const backgroundNode = bgSelector ? (document.querySelector(bgSelector) as HTMLElement | null) : null;
    const background = backgroundNode ? getComputedStyle(backgroundNode).backgroundColor : style.backgroundColor;
    const foreground = luminance(style.color);
    const backgroundLuminance = luminance(background);
    return {
      background,
      color: style.color,
      contrast: (Math.max(foreground, backgroundLuminance) + 0.05) / (Math.min(foreground, backgroundLuminance) + 0.05),
    };
  }, backgroundSelector);
}
