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
    if (path === "/api/admin/sources") return json(route, { items: groups });
    if (path === "/api/admin/overview") return json(route, {
      visits: { total: 12, unique_ips: 4, today: 3, today_unique: 2, last_24h: 3, last_7d_unique: 4 },
      sources: { total: 2, enabled: 2, public: 2, unhealthy: 1, items: groups },
      alerts: { new_count: 1 }
    });
    if (path === "/api/admin/visits") return json(route, { items: [], stats: { total: 12, unique_ips: 4, today: 3, today_unique: 2, last_24h: 3, last_7d_unique: 4 } });
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

  const narrow = (page.viewportSize()?.width || 0) <= 860;
  await page
    .getByRole("searchbox", { name: narrow ? "搜索消息关键词" : "检索资讯关键词" })
    .fill("高危");
  await page.getByRole("button", { name: narrow ? "搜索（移动端）" : "搜索", exact: true }).click();
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

test("Assembly finishes and replays without blocking the live reading controls", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installApi(page);
  await page.goto("/");
  await expect(page.locator(".intro-title")).toContainText("世界在发生");
  await expect(page.locator(".intro-lavender svg")).toBeAttached();
  await expect(page.locator(".editorial-intro")).not.toHaveClass(/is-assembling/, { timeout: 20_000 });
  await page.screenshot({ path: testInfo.outputPath("reading-room.png") });
  await page.getByRole("button", { name: "重播页面组装动画" }).click();
  await expect(page.locator(".hands .pointer").first()).toBeAttached();
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await expect(page).toHaveURL(/media=photo/);
  await expect(page.getByText("供应链组件出现高危漏洞，请优先确认受影响版本。")).toBeVisible();
  await page.locator(".editorial-intro").scrollIntoViewIfNeeded();
  await expect(page.locator(".editorial-intro")).not.toHaveClass(/is-assembling/, { timeout: 20_000 });
  await expect(page.locator(".intro-title")).toHaveText("世界在发生， 消息在这里相遇。", { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test("message text assembles on scroll while copy, pagination and media stay functional", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copiedPost: string }).copiedPost = text; } } });
  });
  await installApi(page);
  const body = "逐字组装消息标题\n\n" + "公开频道的消息在滚动到这里时逐字呈现，完整的正文始终可以复制和阅读。".repeat(7) + "\n\nhttps://example.com/source #阅读";
  await page.route("**/api/public/messages**", async (route) => {
    const more = new URL(route.request().url()).searchParams.has("cursor");
    return json(route, { items: [{ ...messages[0], id: more ? 31 : 30, content: more ? "分页里的新消息也会逐字组装。" : body }], has_more: !more, next_cursor: more ? null : "page-2", total: null });
  });
  await page.goto("/");
  const card = page.locator(".message-card.is-reading").first();
  await expect(card).toHaveAttribute("data-assembly-state", "waiting");
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveAttribute("data-assembly-state", "building");
  const paragraph = card.locator(".pub-rich-line").first();
  await expect.poll(() => paragraph.evaluate((el) => el.style.clipPath)).toMatch(/^path/);
  // Its visible glyphs are still being written, while the DOM and links already hold the full post.
  await expect(paragraph).toContainText("完整的正文始终可以复制和阅读。");
  await expect(card.locator("a[href='https://example.com/source']")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("message-assembly.png") });
  await card.getByRole("button", { name: "复制正文内容" }).click();
  await expect(card).toHaveAttribute("data-assembly-state", "complete");
  expect(await page.evaluate(() => (window as unknown as { copiedPost: string }).copiedPost)).toBe(body);
  expect(await paragraph.evaluate((el) => el.style.clipPath)).toBe("");
  await card.getByRole("button", { name: "查看完整图片 1" }).click();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  const appended = page.locator(".message-card.is-reading").nth(1);
  await appended.scrollIntoViewIfNeeded();
  await expect(appended).toHaveAttribute("data-assembly-state", "building");
  const began = Date.now();
  await expect(appended).toHaveAttribute("data-assembly-state", "complete", { timeout: 4_000 });
  expect(Date.now() - began).toBeLessThan(4_000);
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await expect(card).toHaveAttribute("data-assembly-state", "complete");
  await expect(card.locator(".message-assembly-layer")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Alfama loads on approach, follows reading light and respects reduced motion", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await installApi(page);
  await page.goto("/");
  await expect(page.locator(".intro-title")).toContainText("消息在这里相遇");
  await expect(page.locator(".hands .pointer")).toHaveCount(0);
  await page.locator(".message-card.is-reading").first().scrollIntoViewIfNeeded();
  await expect(page.locator(".message-assembly-layer")).toHaveCount(0);
  expect(await page.locator(".pub-rich-line").first().evaluate((el) => el.style.clipPath)).toBe("");
  expect(requested.some((url) => url.includes("assembly-runtime"))).toBe(false);
  await page.locator(".editorial-footer").scrollIntoViewIfNeeded();
  await expect(page.locator(".footer-world .world--alfama")).toBeAttached();
  const footer = page.locator(".editorial-footer");
  await expect(footer).toHaveAttribute("data-light", "day");
  await footer.screenshot({ path: testInfo.outputPath("alfama-day.png") });
  await footer.getByRole("button", { name: "切换到夜间" }).click();
  await expect(footer).toHaveAttribute("data-light", "night");
  await expect(footer.locator(".pane--night").first()).toBeVisible();
  await footer.screenshot({ path: testInfo.outputPath("alfama-night.png") });
  expect(await footer.locator(".al-tram > svg").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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

  // The control must stay legible: either a dark fill with light text (paper) or
  // a light fill with dark text (dark themes).
  expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
  expect(colors.background === "rgb(255, 255, 255)").toBe(false);
});

test("dark themes keep inverted controls readable", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("tm-theme", "midnight"));
  await installApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "频道资讯" })).toBeVisible();
  for (const selector of [
    ".pub-segment[aria-pressed='true']",
    ".pub-source[aria-checked='true'] .pub-source-name",
    ".pub-search-submit"
  ]) {
    const colors = await elementColors(page.locator(selector).first());
    expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
  }
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

test("light theme keeps secondary text readable", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("tm-theme", "paper"));
  await installApi(page);
  await page.goto("/");
  await expect(page.getByText("供应链组件出现高危漏洞，请优先确认受影响版本。")).toBeVisible();
  const colors = await elementColors(page.locator(".pub-day span").first(), "body");
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
