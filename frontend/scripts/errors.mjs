// Fails if any theme/viewport logs a console error or throws.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const sources = JSON.parse(readFileSync("/tmp/sources.json","utf8"));
const messages = JSON.parse(readFileSync("/tmp/messages-page.json","utf8"));
const url = process.env.SHOT_URL || "http://127.0.0.1:4180/";
const browser = await chromium.launch();
let problems = 0;
for (const [name, vp] of [["desktop",{width:1440,height:900}],["tablet",{width:834,height:1000}],["mobile",{width:390,height:844}]]) {
  const ctx = await browser.newContext({ viewport: vp });
  await ctx.route("**/api/public/sources", r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(sources)}));
  await ctx.route("**/api/public/messages**", r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(messages)}));
  await ctx.route("**/api/public/media/**", r=>r.fulfill({status:404, body:""}));
  for (const theme of ["paper","midnight","aurora","ember"]) {
    const page = await ctx.newPage();
    const issues = [];
    page.on("console", m => {
      if (m.type() !== "error") return;
      const text = m.text();
      // Media 404s are intentionally stubbed in this harness.
      if (/status of 404/.test(text) && m.location()?.url?.includes("/api/public/media/")) return;
      issues.push(text);
    });
    page.on("pageerror", e => issues.push("pageerror: " + e.message));
    await page.addInitScript(t => window.localStorage.setItem("tm-theme", t), theme);
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) issues.push(`horizontal overflow ${overflow}px`);
    if (issues.length) { problems += issues.length; console.log(`✗ ${theme}/${name}:`, issues.join(" | ")); }
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(problems ? `PROBLEMS: ${problems}` : "no console errors, no page errors, no horizontal overflow");
process.exitCode = problems ? 1 : 0;
