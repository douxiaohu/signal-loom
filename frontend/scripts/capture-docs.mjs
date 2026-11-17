import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(
  /\/$/,
  "",
);
const out = root + "/docs/images";
const base = process.env.DOCS_BASE_URL || "http://127.0.0.1:4190";
const stamp = "2026-11-17T08:10:00Z";
const groups = [
  {
    chat_id: -1001,
    name: "城市漫游",
    source: "https://t.me/example_city",
    public_visible: true,
    enabled: true,
    message_count: 128,
    health_status: "healthy",
    fetched_count: 24,
    saved_count: 6,
  },
  {
    chat_id: -1002,
    name: "开源手记",
    source: "https://t.me/example_dev",
    public_visible: true,
    enabled: true,
    message_count: 96,
    health_status: "healthy",
    fetched_count: 18,
    saved_count: 4,
  },
  {
    chat_id: -1003,
    name: "设计观察",
    source: "https://t.me/example_design",
    public_visible: true,
    enabled: true,
    message_count: 72,
    health_status: "stale",
    fetched_count: 12,
    saved_count: 0,
  },
  {
    chat_id: -1004,
    name: "编辑收件箱",
    source: "https://t.me/example_inbox",
    public_visible: false,
    enabled: true,
    message_count: 35,
    health_status: "healthy",
    fetched_count: 10,
    saved_count: 2,
  },
].map((x, i) => ({
  ...x,
  source_url: x.source,
  source_type: "telegram_public",
  adapter: "telegram_public",
  pending_count: 0,
  last_message_time: stamp,
  last_run_at: stamp,
  last_success_at: stamp,
  last_error: null,
  consecutive_failures: 0,
  new_message_volume: x.saved_count,
}));
const messages = [
  {
    id: 70,
    chat_id: -1001,
    chat_title: "城市漫游",
    sender_name: "周末编辑",
    message_id: 70,
    message_time: stamp,
    source_url: "https://t.me/example_city/70",
    media_type: "photo",
    media_urls: [],
    media_items: [0, 1, 2].map((i) => ({
      url: `/api/public/media/70/${i}?variant=thumbnail`,
      original_url: `/api/public/media/70/${i}?variant=original`,
      kind: "photo",
      role: "media",
    })),
    content:
      "把周末留给一座慢下来的城市\n\n从山间的第一道光，到海边的最后一班电车。沿着街道走一走，听见风，也听见生活。\n\n这组旅途插画，记录了山谷、海岸和午后的拱廊。横图、竖图、方图都保留完整边缘；打开原图，还能看见更多细节。\n\n想把这一页送给朋友？点击右上角的星光按钮，正文与三张插画会一起排进分享卡片，长内容自动分页。",
  },
  {
    id: 69,
    chat_id: -1002,
    chat_title: "开源手记",
    sender_name: "开源编辑",
    message_id: 69,
    message_time: "2026-11-17T07:20:00Z",
    source_url: "https://t.me/example_dev/69",
    media_type: null,
    media_urls: [],
    media_items: [],
    content:
      "本周开源精选：从想法到作品\n\n一个好工具，应该让复杂的事情变得简单。今天整理了三个值得关注的方向：本地优先、清晰的文档，以及可以自由组合的小模块。\n\n版本更新：为自己的项目补上一份 README，让下一个路过的人也能快速开始。",
  },
  {
    id: 68,
    chat_id: -1003,
    chat_title: "设计观察",
    sender_name: "设计编辑",
    message_id: 68,
    message_time: "2026-11-17T06:15:00Z",
    source_url: "https://t.me/example_design/68",
    media_type: null,
    media_urls: [],
    media_items: [],
    content:
      "留白也是内容的一部分\n\n阅读的节奏，来自文字、间距和光线。给页面留一点呼吸的空间，信息也会更容易被看见。",
  },
];
function illustration(i) {
  const [w, h] = [
    [1600, 900],
    [900, 1200],
    [1000, 1000],
  ][i];
  const art = [
    `<rect width="1600" height="900" fill="#ebe9d9"/><circle cx="1190" cy="210" r="106" fill="#ce975f"/><path d="M0 730L330 300 680 700 1000 360 1600 800V900H0Z" fill="#89917b"/><path d="M0 830L500 480 880 820 1280 560 1600 790V900H0Z" fill="#526c61"/><path d="M600 900Q760 760 910 900" fill="#c8b48a"/><text x="88" y="120" font-size="28" letter-spacing="7" fill="#526453">01 / THE QUIET VALLEY</text>`,
    `<rect width="900" height="1200" fill="#e5e6dd"/><circle cx="650" cy="270" r="110" fill="#ddad78"/><path d="M0 660Q350 580 900 710V1200H0Z" fill="#92b6b4"/><path d="M0 900Q430 720 900 930V1200H0Z" fill="#5d8b8c"/><path d="M0 1200V850L340 1000 450 1200Z" fill="#cfba94"/><path d="M350 800L390 360H500L540 800Z" fill="#f5eddb"/><path d="M374 515H514L521 590H367Z" fill="#c8775e"/><rect x="378" y="324" width="134" height="60" rx="4" fill="#455e58"/><path d="M366 325L445 270 524 325Z" fill="#455e58"/><text x="65" y="100" font-size="24" letter-spacing="4" fill="#526453">02 / TOWARD THE SEA</text>`,
    `<rect width="1000" height="1000" fill="#ddc9ae"/><rect x="70" y="70" width="860" height="860" fill="#f1e6d2"/><path d="M210 870V480A290 290 0 01580 480V870" fill="#ba7960"/><path d="M300 870V485A200 200 0 01700 485V870" fill="#778978"/><path d="M360 870V500A140 140 0 01640 500V870" fill="#e1c398"/><ellipse cx="500" cy="870" rx="210" ry="35" fill="#bd9e7d"/><path d="M760 810V590M760 700Q640 620 680 580M760 650Q850 560 860 610" stroke="#526b55" stroke-width="16" fill="none"/><path d="M720 815H800L790 890H730Z" fill="#b16d51"/><text x="110" y="150" font-size="22" letter-spacing="4" fill="#68584a">03 / AN AFTERNOON IN THE ARCADE</text>`,
  ][i];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${art}<rect x="12" y="12" width="${w - 24}" height="${h - 24}" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="2"/></svg>`;
}
const rules = [
  { id: 1, name: "开源版本更新", keyword: "版本更新", enabled: true },
  { id: 2, name: "每周设计精选", keyword: "设计", enabled: true },
  { id: 3, name: "城市路线收藏", keyword: "路线", enabled: false },
].map((x) => ({
  ...x,
  media_type: null,
  quiet_start: null,
  quiet_end: null,
  cooldown_minutes: 30,
  source_ids: [],
  created_at: stamp,
  updated_at: stamp,
}));
const matches = [
  {
    id: 1,
    rule_id: 1,
    rule_name: "开源版本更新",
    keyword: "版本更新",
    status: "new",
    content:
      "版本更新：为自己的项目补上一份 README，让下一个路过的人也能快速开始。",
    chat_title: "开源手记",
  },
  {
    id: 2,
    rule_id: 2,
    rule_name: "每周设计精选",
    keyword: "设计",
    status: "acknowledged",
    content: "设计观察：留白也是内容的一部分。给页面留一点呼吸的空间。",
    chat_title: "设计观察",
  },
].map((x) => ({
  ...x,
  sender_name: "编辑",
  matched_at: stamp,
  message_time: stamp,
  media_type: null,
}));
const trend = [28, 43, 35, 62, 58, 76, 94].map((unique, i) => ({
  date: `2026-11-${11 + i}`,
  count: unique * 3,
  unique,
}));
const stats = {
  total: 2846,
  unique_ips: 913,
  today: 282,
  today_unique: 94,
  last_24h: 282,
  last_7d_unique: 376,
  trend,
};
const visits = [
  ["192.0.2.24", "/", "桌面浏览器"],
  ["198.51.100.18", "/?media=photo", "移动端浏览器"],
  ["203.0.113.42", "/api/public/messages", "桌面浏览器"],
].map(([ip, path, user_agent], i) => ({
  id: i + 1,
  ip,
  path,
  user_agent,
  referer: "",
  method: "GET",
  visited_at: stamp,
}));
const browser = await chromium.launch({ headless: true });
const errors = [];
async function setup(
  viewport = { width: 1440, height: 1000 },
  theme = "paper",
) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  await context.addInitScript(
    (theme) => localStorage.setItem("tm-theme", theme),
    theme,
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let value;
    if (path === "/api/public/config")
      value = {
        name: "拾讯",
        description: "拾起消息，织成日常。",
        base_url: "https://signal.example.com",
      };
    else if (path === "/api/public/messages/70") value = messages[0];
    else if (path === "/api/admin/cache")
      value = {
        bytes: 284632119,
        files: 248,
        max_bytes: 5368709120,
        max_age_days: 30,
        removed: 0,
      };
    else if (path === "/api/session")
      value = { authenticated: true, expires_at: "2099-01-01T00:00:00Z" };
    else if (path === "/api/public/sources")
      value = { items: groups.filter((x) => x.public_visible) };
    else if (path.endsWith("/messages")) {
      const id = url.searchParams.get("chat_id");
      const query = url.searchParams.get("query");
      const media = url.searchParams.get("media");
      value = {
        items: messages.filter(
          (x) =>
            (!id || id === "all" || String(x.chat_id) === id) &&
            (!query || x.content.includes(query)) &&
            (!media || media === "all" || x.media_type === media),
        ),
        has_more: false,
        next_cursor: null,
        total: null,
      };
    } else if (path === "/api/admin/sources") value = { items: groups };
    else if (path === "/api/admin/overview")
      value = {
        visits: stats,
        sources: {
          total: 4,
          enabled: 4,
          public: 3,
          unhealthy: 1,
          items: groups,
        },
        alerts: {
          new_count: 1,
          pending_count: 2,
          acknowledged_count: 1,
          resolved_count: 12,
          rule_count: 3,
          enabled_rule_count: 2,
          pending_age_minutes: 18,
          trend: trend.map((x, i) => ({
            date: x.date,
            count: [1, 3, 2, 5, 3, 4, 2][i],
          })),
        },
      };
    else if (path === "/api/admin/operations/summary")
      value = {
        sources: groups,
        unhealthy_sources: [groups[2]],
        public_source_count: 3,
        source_count: 4,
      };
    else if (path === "/api/admin/rules") value = { items: rules };
    else if (path === "/api/admin/matches") value = { items: matches };
    else if (path === "/api/admin/visits") value = { items: visits, stats };
    else if (path.includes("/media/70/"))
      return route.fulfill({
        contentType: "image/svg+xml",
        body: illustration(Number(path.split("/").pop())),
      });
    else
      return route.fulfill({
        status: 404,
        json: { detail: "Screenshot fixture: unknown route" },
      });
    await route.fulfill({ json: value });
  });
  return page;
}
async function ready(page) {
  await page.evaluate(() => document.fonts.ready);
}
async function shot(page, name) {
  await ready(page);
  await page.screenshot({
    path: `${out}/${name}.png`,
    animations: "disabled",
    fullPage: name === "admin-overview",
  });
  console.log(name);
}
try {
  const page = await setup();
  await page.goto(base);
  await expect(
    page.getByRole("heading", { name: "拾讯", exact: true }),
  ).toBeVisible();
  await ready(page);
  await page.locator(".intro-garden").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "reading-room");
  await page.locator("#reading").scrollIntoViewIfNeeded();
  await expect(page.locator(".pub-media-grid img").first()).toHaveClass(
    /is-loaded/,
  );
  await shot(page, "reading-filters");
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await page.locator(".pub-media-grid").scrollIntoViewIfNeeded();
  for (const img of await page.locator(".pub-media-grid img").all())
    await expect(img).toHaveClass(/is-loaded/);
  await shot(page, "complete-gallery");
  await page
    .getByRole("button", { name: "查看完整图片 2", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "图片预览" }).locator("img"),
  ).toBeVisible();
  await shot(page, "image-viewer");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "生成分享卡片", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分享卡片", exact: true });
  await expect(dialog.locator(".pub-share-image")).toBeVisible({
    timeout: 30000,
  });
  await shot(page, "share-pages");
  while (
    await dialog.getByRole("button", { name: "下一页分享卡片" }).isEnabled()
  )
    await dialog.getByRole("button", { name: "下一页分享卡片" }).click();
  await dialog
    .locator(".pub-share-stage")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  await shot(page, "share-images");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "切换到夜间" }).first().click();
  await page.locator(".editorial-footer").scrollIntoViewIfNeeded();
  await expect(page.locator(".editorial-footer")).toHaveAttribute(
    "data-light",
    "night",
  );
  // Theme transitions finish after the controls and scenery synchronize.
  await page.waitForTimeout(1600);
  await shot(page, "alfama-night");
  const mobile = await setup({ width: 390, height: 844 });
  await mobile.goto(base);
  await ready(mobile);
  await shot(mobile, "mobile-reading");
  await mobile.locator("#reading").scrollIntoViewIfNeeded();
  await shot(mobile, "mobile-feed");
  const admin = await setup();
  await admin.goto(base + "/admin/");
  await expect(
    admin.getByRole("heading", { name: "管理中心", exact: true }),
  ).toBeVisible();
  await expect(
    admin.getByRole("img", { name: "近 7 日独立访客趋势" }),
  ).toBeVisible();
  await admin.waitForTimeout(1100);
  await shot(admin, "admin-overview");
  await admin.getByRole("button", { name: "来源采集", exact: true }).click();
  await admin.locator(".source-composer summary").click();
  await admin.getByLabel("来源名称", { exact: true }).fill("新的阅读清单");
  await admin
    .getByLabel("频道链接", { exact: true })
    .fill("https://t.me/example_reading");
  await shot(admin, "admin-sources");
  await admin.getByRole("button", { name: "规则命中", exact: true }).click();
  await admin.getByText("管理监测规则", { exact: true }).click();
  await shot(admin, "admin-rules");
  await admin.getByRole("button", { name: "消息检索", exact: true }).click();
  await expect(admin.getByLabel("关键词", { exact: true })).toBeVisible();
  await shot(admin, "admin-search");
  await admin.getByRole("button", { name: "访问记录", exact: true }).click();
  await expect(admin.getByText("192.0.2.24", { exact: true })).toBeVisible();
  await admin.waitForTimeout(1100);
  await shot(admin, "admin-visits");
  if (errors.length) throw new Error(errors.join("\n"));
  await admin.getByRole("button", { name: "缓存空间", exact: true }).click();
  await expect(admin.getByText("缓存占用", { exact: true })).toBeVisible();
  await shot(admin, "admin-cache");
  await page.goto(base + "/message/70");
  await expect(page.locator(".pub-rich")).toBeVisible();
  await shot(page, "message-detail");
  await page.getByRole("button", { name: "收藏消息", exact: true }).click();
  await page.goto(base + "/saved");
  await expect(page.locator(".pub-rich")).toBeVisible();
  await shot(page, "saved-stories");
  await page.goto(base);
  await page.getByLabel("Language / 语言").selectOption("en");
  await expect(page.locator(".intro-title")).toContainText(
    "The world keeps moving.",
  );
  await shot(page, "english-reading");
  await writeFile(
    "/private/tmp/signal-loom-docs-capture-result.json",
    JSON.stringify(
      {
        brand: "拾讯 · Signal Loom",
        screenshots: 18,
        pageErrors: errors,
        data: "isolated browser API fixtures; documentation-only IP ranges",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
