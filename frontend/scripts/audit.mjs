// Contrast audit: computes WCAG contrast for every rendered text node per theme.
// Usage: node scripts/audit.mjs [theme,...]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const themes = (process.argv[2] || "paper,midnight,aurora,ember").split(",");
const sources = JSON.parse(readFileSync("/tmp/sources.json", "utf8"));
const messages = JSON.parse(readFileSync("/tmp/messages-page.json", "utf8"));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.route("**/api/public/sources", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sources) }));
await ctx.route("**/api/public/messages**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(messages) }));
await ctx.route("**/api/public/media/**", (r) => r.fulfill({ status: 404, body: "" }));

const report = {};
for (const theme of themes) {
  const page = await ctx.newPage();
  await page.addInitScript((t) => window.localStorage.setItem("tm-theme", t), theme);
  await page.goto(process.env.SHOT_URL || "http://127.0.0.1:4173/", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  report[theme] = await page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const p = m[1].split(",").map((n) => parseFloat(n));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      }
      const m2 = c.match(/color\(srgb ([^)]+)\)/);
      if (m2) {
        const p = m2[1].split(/[\s/]+/).map((n) => parseFloat(n));
        return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
      }
      return null;
    };
    const lin = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const blend = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1
    });
    const bgOf = (el) => {
      const stack = [];
      let node = el;
      while (node && node.nodeType === 1) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c && c.a > 0) stack.push(c);
        node = node.parentElement;
      }
      stack.push(parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 });
      let bg = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = stack.length - 1; i >= 0; i -= 1) bg = blend(stack[i], bg);
      return bg;
    };
    const results = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
      if (!ownText) continue;
      // Decorative glyphs (separators, marks) are intentionally low contrast.
      if (el.getAttribute("aria-hidden") === "true") continue;
      // Gradient-filled badges: the painted background is the gradient, which the
      // flat-colour walker cannot see, so they are reviewed visually instead.
      if (/gradient/.test(cs.backgroundImage)) continue;
      const fgRaw = parse(cs.color);
      if (!fgRaw) continue;
      const bg = bgOf(el);
      const fg = blend(fgRaw, bg);
      let ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
      const size = parseFloat(cs.fontSize);
      const bold = parseInt(cs.fontWeight, 10) >= 600;
      const large = size >= 24 || (size >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      const key = `${cs.color}|${Math.round(size)}|${ownText.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (ratio < need) {
        results.push({
          text: ownText.replace(/\s+/g, " ").slice(0, 46),
          cls: (el.className || "").toString().slice(0, 90),
          color: cs.color,
          bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
          size: Math.round(size),
          ratio: Math.round(ratio * 100) / 100
        });
      }
    }
    return results;
  });
  await page.close();
}
await browser.close();

let total = 0;
for (const [theme, list] of Object.entries(report)) {
  total += list.length;
  console.log(`\n=== ${theme}: ${list.length} low-contrast text nodes ===`);
  for (const r of list.slice(0, 40)) console.log(` ${String(r.ratio).padEnd(5)} ${r.text}\n        color=${r.color} bg=${r.bg} size=${r.size} class=${r.cls}`);
}
console.log(`\nTOTAL ISSUES: ${total}`);
process.exitCode = total > 0 ? 1 : 0;
