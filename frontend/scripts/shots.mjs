// Screenshots backed by real API fixtures captured from production.
// Usage: node scripts/shots.mjs [label]
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const url = process.env.SHOT_URL || "http://127.0.0.1:4173/";
const outDir = process.env.SHOT_OUT || "/tmp/shots";
const label = process.argv[2] || "current";
const themes = (process.env.SHOT_THEMES || "paper,midnight,aurora,ember").split(",");
const sizes = (process.env.SHOT_SIZES || "desktop,mobile").split(",");

const sources = JSON.parse(readFileSync("/tmp/sources.json", "utf8"));
const messages = JSON.parse(readFileSync("/tmp/messages-page.json", "utf8"));
mkdirSync(outDir, { recursive: true });

const viewports = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1000 },
  mobile: { width: 390, height: 844 }
};

const browser = await chromium.launch();

for (const size of sizes) {
  const ctx = await browser.newContext({ viewport: viewports[size], deviceScaleFactor: 1 });
  await ctx.route("**/api/public/sources", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sources) })
  );
  await ctx.route("**/api/public/messages**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(messages) })
  );
  await ctx.route("**/api/public/media/**", (route) => route.fulfill({ status: 404, body: "" }));

  for (const theme of themes) {
    const page = await ctx.newPage();
    await page.addInitScript((t) => window.localStorage.setItem("tm-theme", t), theme);
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${outDir}/${label}-${theme}-${size}.png`, fullPage: size !== "mobile" });
    await page.close();
  }
  await ctx.close();
}

await browser.close();
console.log(`shots written to ${outDir}`);
