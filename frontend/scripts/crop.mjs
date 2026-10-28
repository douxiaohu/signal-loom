// Zoomed crops of the public site for close visual inspection.
// Usage: node scripts/crop.mjs <label> <theme> [selector]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const label = process.argv[2] || "current";
const theme = process.argv[3] || "paper";
const selector = process.argv[4] || "body";
const sources = JSON.parse(readFileSync("/tmp/sources.json", "utf8"));
const messages = JSON.parse(readFileSync("/tmp/messages-page.json", "utf8"));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
await ctx.route("**/api/public/sources", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sources) }));
await ctx.route("**/api/public/messages**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(messages) }));
await ctx.route("**/api/public/media/**", (r) => r.fulfill({ status: 404, body: "" }));
const page = await ctx.newPage();
await page.addInitScript((t) => window.localStorage.setItem("tm-theme", t), theme);
await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
await page.waitForTimeout(500);
const el = await page.$(selector);
await el.screenshot({ path: `/tmp/shots/crop-${label}-${theme}.png` });
await browser.close();
console.log("ok");
