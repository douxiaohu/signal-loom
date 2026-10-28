// Checks the live production site in a real browser across themes and viewports.
import { chromium } from "playwright";
const url = process.env.LIVE_URL || "https://douxiaohu.duckdns.org/";
const browser = await chromium.launch();
let issues = 0;
for (const [name, vp] of [["desktop",{width:1440,height:900}],["mobile",{width:390,height:844}]]) {
  const ctx = await browser.newContext({ viewport: vp });
  for (const theme of ["paper","midnight","aurora","ember"]) {
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error" && !/status of (404|500)/.test(m.text())) errors.push(m.text()); });
    await page.addInitScript(t => window.localStorage.setItem("tm-theme", t), theme);
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1200);
    const stats = await page.evaluate(() => {
      const cards = document.querySelectorAll("article.message-card").length;
      const overflow = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
      const imgs = [...document.querySelectorAll(".pub-media-img")];
      const loaded = imgs.filter(i => i.complete && i.naturalWidth > 0).length;
      const heading = document.querySelector(".pub-rich-heading");
      const hColor = heading ? getComputedStyle(heading).color : null;
      return { cards, overflow, imgs: imgs.length, loaded, hColor };
    });
    const ok = stats.cards > 0 && stats.overflow <= 1 && errors.length === 0;
    if (!ok) issues++;
    console.log(`${ok ? "✓" : "✗"} ${theme}/${name}: cards=${stats.cards} overflow=${stats.overflow} imgs=${stats.loaded}/${stats.imgs} h1color=${stats.hColor}${errors.length ? " err=" + errors.slice(0,2).join(";") : ""}`);
    if (theme === "paper" && name === "desktop") await page.screenshot({ path: "/tmp/shots/live-paper.png" });
    if (theme === "midnight" && name === "mobile") await page.screenshot({ path: "/tmp/shots/live-midnight-mobile.png" });
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(issues ? `ISSUES: ${issues}` : "live site OK in all themes/viewports");
