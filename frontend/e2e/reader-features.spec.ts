import { expect, test, type Page } from "@playwright/test";
import jsQR from "jsqr";
const content =
  "一篇值得保存的文章\n\n" +
  Array.from(
    { length: 12 },
    (_, i) =>
      `段落 ${i + 1}：阅读进度应该恢复到上次停留的消息。收藏不保存正文，而是在打开时重新检查公开权限。`,
  ).join("\n\n");
const post = {
  id: 80,
  chat_id: -80,
  chat_title: "演示来源",
  message_id: 80,
  sender_name: "编辑",
  message_time: "2026-11-17T08:00:00Z",
  content,
  media_type: null,
  media_urls: [],
  media_items: [],
  source_url: "https://t.me/example/80",
};
async function fixtures(page: Page) {
  const state = { visible: true };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/public/config")
      return route.fulfill({
        json: {
          name: "我的阅读室",
          description: "A personal reading room",
          base_url: "https://reader.example",
        },
      });
    if (path === "/api/public/sources")
      return route.fulfill({
        json: {
          items: [
            {
              chat_id: -80,
              name: "演示来源",
              source_url: "https://t.me/example",
              message_count: 1,
              last_message_time: post.message_time,
              health_status: "healthy",
            },
          ],
        },
      });
    if (path === "/api/public/messages")
      return route.fulfill({
        json: {
          items: [post],
          has_more: false,
          next_cursor: null,
          total: null,
        },
      });
    if (path === "/api/public/messages/80")
      return route.fulfill(
        state.visible
          ? { json: post }
          : { status: 404, json: { detail: "Message not found" } },
      );
    return route.fulfill({ status: 404, json: { detail: "Not found" } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  return state;
}

test("site configuration, ID-only favorites, and revoked publication", async ({
  page,
}) => {
  const state = await fixtures(page);
  await page.goto("/");
  await expect(page).toHaveTitle("我的阅读室 · Signal Loom");
  await expect(page.locator(".intro-description")).toHaveText(
    "A personal reading room",
  );
  await expect(page.locator(".pub-brand-name")).toHaveText("我的阅读室");
  await page.getByRole("button", { name: "收藏消息", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "取消收藏", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(() => localStorage.getItem("signal-saved-ids")),
  ).toBe("[80]");
  await page
    .locator(".pub-header-actions")
    .getByRole("link", { name: "收藏", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "我的收藏" })).toBeVisible();
  await expect(page.locator(".pub-rich")).toContainText("一篇值得保存的文章");
  state.visible = false;
  await page.reload();
  await expect(
    page.getByText("部分收藏已不可用", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".pub-rich")).toHaveCount(0);
  await page.getByRole("button", { name: "移除不可用收藏" }).click();
  await expect(page.getByText("还没有收藏", { exact: true })).toBeVisible();
});

test("four languages persist, update dates and fit the viewport", async ({
  page,
}) => {
  await fixtures(page);
  await page.goto("/");
  for (const [locale, heading, media, search] of [
    ["en", "Something worth reading.", "Photos", "Search"],
    ["ja", "いま、読みたいもの。", "画像", "検索"],
    ["es", "Algo que merece una pausa.", "Fotos", "Buscar"],
    ["zh-CN", "此刻，值得一读", "图片", "搜索"],
  ]) {
    await page.getByLabel("Language / 语言").selectOption(locale);
    await expect(page.locator(".reading-head h2")).toContainText(heading);
    await expect(
      page.getByRole("button", { name: media, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".pub-search-submit").first()).toHaveText(search);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.getByLabel("Language / 语言").selectOption("en");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Create share cards" }),
  ).toBeVisible();
  await expect(page.locator(".intro-title")).toContainText(
    "The world keeps moving.",
  );
  await page.screenshot({
    path: test.info().outputPath("english-reading.png"),
  });
});

test("a permalink respects visibility and share QR decodes to the configured origin", async ({
  page,
}) => {
  const state = await fixtures(page);
  await page.addInitScript(() => {
    const context = CanvasRenderingContext2D.prototype;
    const original = context.drawImage;
    (window as any).qrPixels = null;
    context.drawImage = function (...args: Parameters<typeof original>) {
      const image = args[0];
      if (image instanceof HTMLCanvasElement && image.width === 144) {
        const data = image.getContext("2d")!.getImageData(0, 0, 144, 144);
        (window as any).qrPixels = {
          pixels: [...data.data],
          width: 144,
          height: 144,
        };
      }
      return original.apply(this, args);
    };
  });
  await page.goto("/message/80");
  await expect(page.locator(".pub-rich")).toContainText("一篇值得保存的文章");
  await page.getByRole("button", { name: "生成分享卡片" }).click();
  await expect(page.locator(".pub-share-image")).toBeVisible({
    timeout: 20000,
  });
  const image = await page.evaluate(() => (window as any).qrPixels);
  expect(
    jsQR(Uint8ClampedArray.from(image.pixels), image.width, image.height)?.data,
  ).toBe("https://reader.example/message/80");
  await page.screenshot({
    path: test.info().outputPath("message-qr-share.png"),
  });
  state.visible = false;
  await page.goto("/message/80");
  await expect(
    page.getByText("消息不可用或未公开", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".pub-rich")).toHaveCount(0);
});

test("reading position restores filters and the last viewed message", async ({
  page,
}) => {
  await fixtures(page);
  await page.goto("/?query=收藏");
  const card = page.locator('[data-message-id="80"]');
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, 180));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("signal-reading-position") || "null")
            ?.id,
      ),
    )
    .toBe(80);
  await page.goto("/");
  await page.getByRole("link", { name: "继续上次阅读", exact: true }).click();
  await expect(page).toHaveURL(/query=/);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
  expect(new URL(page.url()).searchParams.get("query")).toBe("收藏");
});

test("an interrupted favorite request can be retried without deleting saved IDs", async ({
  page,
}) => {
  await fixtures(page);
  await page.addInitScript(() =>
    localStorage.setItem("signal-saved-ids", "[80]"),
  );
  let fail = true;
  await page.route("**/api/public/messages/80", (route) =>
    route.fulfill(
      fail ? { status: 503, json: { detail: "Unavailable" } } : { json: post },
    ),
  );
  await page.goto("/saved");
  await expect(page.getByRole("alert")).toContainText("暂时无法加载");
  expect(
    await page.evaluate(() => localStorage.getItem("signal-saved-ids")),
  ).toBe("[80]");
  fail = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".pub-rich")).toContainText("一篇值得保存的文章");
});

test("custom descriptions remain text inside the animated introduction", async ({
  page,
}) => {
  await fixtures(page);
  const description = '<img src=x onerror="window.descriptionExecuted=true">';
  await page.route("**/api/public/config", (route) =>
    route.fulfill({
      json: {
        name: "Custom room",
        description,
        base_url: "https://reader.example",
      },
    }),
  );
  await page.goto("/");
  await expect(page.locator(".intro-description")).toHaveText(description);
  await expect(page.locator(".intro-description img")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).descriptionExecuted),
  ).toBeUndefined();
});

test("cache maintenance stays behind the admin session and reports its result", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: { authenticated: true, expires_at: "2099-01-01T00:00:00Z" },
    }),
  );
  await page.route("**/api/admin/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/cache" || path === "/api/admin/cache/prune")
      return route.fulfill({
        json: {
          bytes: 1024,
          files: 2,
          max_bytes: 5368709120,
          max_age_days: 30,
          removed: path.endsWith("prune") ? 3 : 0,
        },
      });
    return route.fulfill({
      json: { items: [], sources: [], unhealthy_sources: [] },
    });
  });
  await page.goto("/admin/?view=cache");
  await expect(
    page.getByRole("heading", { name: "缓存空间", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清理缓存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已清理 3 个缓存文件");
});
