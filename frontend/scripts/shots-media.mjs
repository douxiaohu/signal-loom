// Screenshots with synthetic media so the image/gallery paths are exercised.
// Usage: node scripts/shots-media.mjs [label]
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const outDir = "/tmp/shots";
const label = process.argv[2] || "media";
const sources = JSON.parse(readFileSync("/tmp/sources.json", "utf8"));
const messages = JSON.parse(readFileSync("/tmp/messages-page.json", "utf8"));
mkdirSync(outDir, { recursive: true });

// Give the first message a 3-photo gallery and the second a single wide photo.
const svg = (w, h, from, to, text) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="52%" font-family="sans-serif" font-size="${Math.round(w / 9)}" fill="rgba(255,255,255,.92)" text-anchor="middle">${text}</text></svg>`;

const mediaMap = {
  0: svg(1600, 900, "#0ea5e9", "#4f46e5", "相册 1"),
  1: svg(1200, 1200, "#f59e0b", "#ef4444", "相册 2"),
  2: svg(1600, 1000, "#10b981", "#0f766e", "相册 3"),
  3: svg(1800, 900, "#8b5cf6", "#ec4899", "封面大图"),
};

const browser = await chromium.launch();
const routes = async (ctx) => {
await ctx.route("**/api/public/sources", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sources) }));
await ctx.route("**/api/public/messages**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(messages) }));
await ctx.route("**/api/public/media/**", (r) => {
  const url = new URL(r.request().url());
  const id = url.pathname.split("/").pop();
  const body = mediaMap[Number(id) % 4];
  return r.fulfill({ status: 200, contentType: "image/svg+xml", body });
});
};

for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await routes(ctx);
  const page = await ctx.newPage();
  await page.addInitScript(() => window.localStorage.setItem("tm-theme", "paper"));
  await page.addInitScript((list) => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("/api/public/messages")) {
        const data = await response.clone().json();
        data.items[0].media_type = "photo";
        data.items[0].media_items = [0, 1, 2].map((n) => ({
          url: `/api/public/media/${n}/0?variant=thumbnail`,
          original_url: `/api/public/media/${n}/0?variant=original`,
          kind: "image",
          role: "media"
        }));
        data.items[1].media_type = "photo";
        data.items[1].media_items = [{
          url: `/api/public/media/3/0?variant=thumbnail`,
          original_url: `/api/public/media/3/0?variant=original`,
          kind: "image",
          role: "media"
        }];
        return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return response;
    };
  }, []);
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${outDir}/${label}-${name}.png`, fullPage: name === "desktop" });
  await page.close();
  await ctx.close();
}
await browser.close();
console.log("done");
