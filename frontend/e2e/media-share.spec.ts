import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

const dimensions = [
  [500, 1500],
  [1600, 500],
  [800, 800],
];
const bodyParagraphs = Array.from(
  { length: 65 },
  (_, i) =>
    `第${String(i + 1).padStart(2, "0")}段：长文字必须完整保留，不能省略；横图、竖图与方图都应展示全部内容，分页之后也应保持段落顺序和正常排版。`,
);
const longBody =
  "长文与多图完整分享测试标题\n\n" +
  bodyParagraphs.join("\n\n") +
  "\n\n全文结束-END-65 https://example.com/complete-source";

function photo(index: number, thumb: boolean) {
  const [w, h] = dimensions[index];
  const ratio = thumb ? 0.25 : 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * ratio}" height="${h * ratio}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${["#e2ebd8", "#eddccf", "#d6e5ef"][index]}"/><rect x="8" y="8" width="${w - 16}" height="${h - 16}" fill="none" stroke="#3c5141" stroke-width="10"/><rect width="60" height="60" fill="#be6152"/><rect x="${w - 60}" width="60" height="60" fill="#577894"/><rect y="${h - 60}" width="60" height="60" fill="#b69246"/><rect x="${w - 60}" y="${h - 60}" width="60" height="60" fill="#647b4d"/><text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-size="${Math.min(w, h) / 8}" fill="#3c5141">PHOTO ${index + 1}</text><text x="${w / 2}" y="${h - 90}" text-anchor="middle" font-size="${Math.min(w, h) / 15}" fill="#3c5141">BOTTOM EDGE ${index + 1}</text></svg>`;
}

async function servePost(
  page: Page,
  content: string,
  count = 3,
  failed = false,
) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/public/config")
      return route.fulfill({
        json: {
          name: "拾讯",
          description: "Demo",
          base_url: "https://douxiaohu.duckdns.org",
        },
      });
    if (url.pathname === "/api/public/sources")
      return route.fulfill({
        json: {
          items: [
            {
              chat_id: -70,
              name: "图片与长文测试频道",
              source_url: "https://t.me/example",
              message_count: 1,
              last_message_time: "2026-11-17T02:00:00Z",
              health_status: "healthy",
            },
          ],
        },
      });
    if (url.pathname === "/api/public/messages")
      return route.fulfill({
        json: {
          items: [
            {
              id: 70,
              chat_id: -70,
              chat_title: "图片与长文测试频道",
              sender_name: "编辑",
              message_id: 70,
              message_time: "2026-11-17T02:00:00Z",
              content,
              source_url: "https://t.me/example/70",
              media_type: "photo",
              media_urls: [],
              media_items: Array.from({ length: count }, (_, index) => ({
                url: `/api/public/media/70/${index}?variant=thumbnail`,
                original_url: `/api/public/media/70/${index}?variant=original`,
                kind: "photo",
                role: "media",
              })),
            },
          ],
          has_more: false,
          next_cursor: null,
          total: null,
        },
      });
    const match = url.pathname.match(/\/api\/public\/media\/70\/(\d+)/);
    if (match) {
      const index = Number(match[1]);
      const original = url.searchParams.get("variant") === "original";
      if (failed && (index === 1 || (index === 0 && original)))
        return route.fulfill({ status: 404 });
      return route.fulfill({
        contentType: "image/svg+xml",
        body: photo(index, !original),
      });
    }
    return route.fulfill({ status: 404 });
  });
}

async function inspectCanvas(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as {
      sharePaint: { text: string; font: string }[];
      sharePhotos: {
        src: string;
        args: number;
        width: number;
        height: number;
        drawnWidth: number;
        drawnHeight: number;
      }[];
      copiedSize: number;
    };
    state.sharePaint = [];
    state.sharePhotos = [];
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      ...args: Parameters<typeof fill>
    ) {
      state.sharePaint.push({ text: args[0], font: this.font });
      return fill.apply(this, args);
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      ...args: Parameters<typeof draw>
    ) {
      const image = args[0];
      if (image instanceof HTMLImageElement)
        state.sharePhotos.push({
          src: image.src,
          args: args.length,
          width: image.naturalWidth,
          height: image.naturalHeight,
          drawnWidth: Number(args[3]),
          drawnHeight: Number(args[4]),
        });
      return draw.apply(this, args);
    };
    Object.defineProperty(window, "ClipboardItem", {
      configurable: true,
      value: class {
        data: Record<string, Blob>;
        constructor(data: Record<string, Blob>) {
          this.data = data;
        }
      },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items: { data: Record<string, Blob> }[]) => {
          state.copiedSize = items[0].data["image/png"].size;
        },
      },
    });
  });
}

test("long share posts preserve every paragraph and all photos without cropping", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await inspectCanvas(page);
  await servePost(page, longBody);
  await page.goto("/");
  const gallery = page.locator(".pub-media-grid");
  await gallery.scrollIntoViewIfNeeded();
  const images = gallery.locator("img");
  await expect(images).toHaveCount(3);
  for (const img of await images.all()) {
    await expect(img).toHaveClass(/is-loaded/);
    expect(await img.evaluate((el) => getComputedStyle(el).objectFit)).toBe(
      "contain",
    );
    expect(
      await img.evaluate(
        (el) =>
          el.getBoundingClientRect().bottom <=
          el.closest(".pub-media-cell")!.getBoundingClientRect().bottom + 1,
      ),
    ).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("complete-gallery.png") });
  await page.getByRole("button", { name: "生成分享卡片" }).click();
  const dialog = page.getByRole("dialog", { name: "分享卡片", exact: true });
  await expect(dialog.locator(".pub-share-image")).toBeVisible({
    timeout: 30_000,
  });
  const pageCount = Number(
    (await dialog.locator(".pub-share-pagination").innerText()).match(
      /·\s*(\d+)\s*页/,
    )![1],
  );
  expect(pageCount).toBeGreaterThan(1);
  const paints = await page.evaluate(
    () =>
      (window as unknown as { sharePaint: { text: string; font: string }[] })
        .sharePaint,
  );
  expect(
    paints.filter(
      ({ text }) => text === "https://douxiaohu.duckdns.org/message/70",
    ),
  ).toHaveLength(pageCount);
  const body = paints
    .filter(({ font }) => font.includes("32px"))
    .map(({ text }) => text)
    .join("");
  for (const paragraph of bodyParagraphs) expect(body).toContain(paragraph);
  expect(body).toContain("全文结束-END-65 https://example.com/complete-source");
  const photos = await page.evaluate(
    () =>
      (
        window as unknown as {
          sharePhotos: {
            src: string;
            args: number;
            width: number;
            height: number;
            drawnWidth: number;
            drawnHeight: number;
          }[];
        }
      ).sharePhotos,
  );
  expect(photos).toHaveLength(3);
  photos.forEach((image, i) => {
    expect(image.src).toContain("variant=original");
    expect(image.args).toBe(5);
    expect(image.width).toBe(dimensions[i][0]);
    expect(image.drawnWidth / image.drawnHeight).toBeCloseTo(
      image.width / image.height,
      5,
    );
  });
  await dialog.screenshot({ path: testInfo.outputPath("share-long-text.png") });
  for (let i = 1; i < pageCount; i++)
    await dialog.getByRole("button", { name: "下一页分享卡片" }).click();
  await expect
    .poll(() => dialog.locator("img").evaluate((el) => el.naturalWidth))
    .toBe(1620);
  await dialog.getByRole("button", { name: "复制当前页" }).click();
  await expect(dialog.getByRole("button", { name: "已复制" })).toBeVisible();
  const expectedSize = await dialog
    .locator("img")
    .evaluate(async (el) => (await (await fetch(el.src)).blob()).size);
  expect(
    await page.evaluate(
      () => (window as unknown as { copiedSize: number }).copiedSize,
    ),
  ).toBe(expectedSize);
  await dialog.screenshot({
    path: testInfo.outputPath("share-complete-photos.png"),
  });
  const downloadEvent = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载全部" }).click();
  const download = await downloadEvent;
  const archivePath = testInfo.outputPath("share-pages.zip");
  await download.saveAs(archivePath);
  const zip = await readFile(archivePath);
  let offset = 0;
  let entries = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const start =
      offset +
      30 +
      zip.readUInt16LE(offset + 26) +
      zip.readUInt16LE(offset + 28);
    const png = zip.subarray(start, start + size);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1620);
    expect(png.readUInt32BE(20)).toBeLessThanOrEqual(3900);
    entries++;
    if (entries === pageCount)
      await writeFile(testInfo.outputPath("last-share-page.png"), png);
    offset = start + size;
  }
  expect(entries).toBe(pageCount);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "生成分享卡片" }),
  ).toBeFocused();
});

test("failed share photos keep their place and original failures fall back to thumbnails", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await inspectCanvas(page);
  await servePost(page, "图片失败时也应保留位置和完整正文。", 2, true);
  await page.goto("/");
  await page.getByRole("button", { name: "生成分享卡片" }).click();
  const dialog = page.getByRole("dialog", { name: "分享卡片", exact: true });
  await expect(dialog.locator(".pub-share-image")).toBeVisible({
    timeout: 20_000,
  });
  await expect(dialog.locator(".pub-share-hint")).toContainText(
    "有 1 张图片暂未加载",
  );
  const photos = await page.evaluate(
    () => (window as unknown as { sharePhotos: { src: string }[] }).sharePhotos,
  );
  expect(photos).toHaveLength(1);
  expect(photos[0].src).toContain("variant=thumbnail");
  const texts = await page.evaluate(() =>
    (window as unknown as { sharePaint: { text: string }[] }).sharePaint
      .map(({ text }) => text)
      .join(""),
  );
  expect(texts).toContain("图片 2 暂未加载，请查看原文");
  await dialog.screenshot({
    path: testInfo.outputPath("share-unavailable-photo.png"),
  });
});

test("a tall single photo stays inside its preview and exports completely on one page", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await inspectCanvas(page);
  await servePost(page, "单张长图应完整显示，不裁掉底部。", 1);
  await page.goto("/");
  const image = page.locator(".pub-media-single img");
  await image.scrollIntoViewIfNeeded();
  await expect(image).toHaveClass(/is-loaded/);
  expect(
    await image.evaluate((el) => {
      const img = el.getBoundingClientRect();
      const frame = el.closest(".pub-media-cell")!.getBoundingClientRect();
      return (
        img.top >= frame.top - 1 &&
        img.bottom <= frame.bottom + 1 &&
        getComputedStyle(el).objectFit === "contain"
      );
    }),
  ).toBe(true);
  await page.getByRole("button", { name: "生成分享卡片" }).click();
  const dialog = page.getByRole("dialog", { name: "分享卡片", exact: true });
  await expect(dialog.locator(".pub-share-pagination")).toHaveText(
    "1 张图片 · 1 页",
  );
  const event = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载图片", exact: true }).click();
  const download = await event;
  await download.saveAs(testInfo.outputPath("single-tall-photo.png"));
  const photos = await page.evaluate(
    () =>
      (
        window as unknown as {
          sharePhotos: {
            width: number;
            height: number;
            drawnWidth: number;
            drawnHeight: number;
          }[];
        }
      ).sharePhotos,
  );
  expect(photos).toHaveLength(1);
  expect(photos[0].drawnWidth / photos[0].drawnHeight).toBeCloseTo(1 / 3, 5);
});

test("text-only shares tolerate legacy empty media fields", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await inspectCanvas(page);
  await servePost(page, "只有正文也应该能够正常生成分享卡片。", 0);
  await page.route("**/api/public/messages**", async (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 71,
            chat_id: -70,
            chat_title: "纯文字频道",
            sender_name: "编辑",
            message_id: 71,
            message_time: "2026-11-17T02:00:00Z",
            content: "只有正文也应该能够正常生成分享卡片。",
            source_url: "",
            media_type: null,
            media_urls: null,
            media_items: null,
          },
        ],
        has_more: false,
        next_cursor: null,
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "生成分享卡片" }).click();
  const dialog = page.getByRole("dialog", { name: "分享卡片", exact: true });
  await expect(dialog.locator(".pub-share-pagination")).toHaveText(
    "0 张图片 · 1 页",
  );
  await expect(
    dialog.getByRole("button", { name: "下载图片", exact: true }),
  ).toBeEnabled();
  const siteLinks = await page.evaluate(
    () =>
      (
        window as unknown as { sharePaint: { text: string }[] }
      ).sharePaint.filter(
        ({ text }) => text === "https://douxiaohu.duckdns.org/message/71",
      ).length,
  );
  expect(siteLinks).toBe(1);
});
