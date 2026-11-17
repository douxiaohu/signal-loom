import { useEffect, useRef } from "react";
import { ArrowUpRight, ArrowUp, Flower2 } from "lucide-react";
import { ReadingLightSwitch, useStoredTheme } from "../../theme";

export default function LandscapeFooter() {
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const theme = useStoredTheme();

  useEffect(() => {
    const el = root.current;
    if (!el || !window.IntersectionObserver) return;
    const controller = new AbortController();
    const calm = matchMedia("(prefers-reduced-motion: reduce)");
    let loaded = false;
    let visible = false;
    let frame = 0;
    let restTimer = 0;
    let last = 0;
    let filmTime = 0;
    let animations: Animation[] = [];
    const stop = () => { cancelAnimationFrame(frame); frame = 0; el.classList.remove("is-awake"); };
    const tick = (now: number) => {
      if (now - last >= 1000 / 24) {
        filmTime += Math.min(now - last, 80);
        animations.forEach((animation) => { animation.currentTime = filmTime; });
        last = now;
      }
      frame = requestAnimationFrame(tick);
    };
    const wake = () => {
      clearTimeout(restTimer);
      if (visible && !document.hidden && !calm.matches && !frame) { last = performance.now(); frame = requestAnimationFrame(tick); el.classList.add("is-awake"); }
      restTimer = window.setTimeout(stop, 8000);
    };
    const watch = new IntersectionObserver(async ([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !loaded) {
        loaded = true;
        try {
          const response = await fetch("/artwork/alfama.html", { signal: controller.signal });
          if (!response.ok) return;
          const art = await response.text();
          if (controller.signal.aborted || !stage.current) return;
          stage.current.innerHTML = art;
          animations = stage.current.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getTiming().iterations === Infinity);
          animations.forEach((animation) => animation.pause());
          if (visible) wake();
        } catch { /* The footer's links remain usable without decorative artwork. */ }
      }
      visible ? wake() : stop();
    }, { rootMargin: "160px" });
    const visibility = () => document.hidden ? stop() : wake();
    const reduce = () => calm.matches ? stop() : wake();
    watch.observe(el);
    ["pointermove", "keydown", "touchstart", "scroll"].forEach((event) => window.addEventListener(event, wake, { passive: true }));
    document.addEventListener("visibilitychange", visibility);
    calm.addEventListener("change", reduce);
    return () => { controller.abort(); watch.disconnect(); stop(); clearTimeout(restTimer); animations.forEach((animation) => animation.cancel()); ["pointermove", "keydown", "touchstart", "scroll"].forEach((event) => window.removeEventListener(event, wake)); document.removeEventListener("visibilitychange", visibility); calm.removeEventListener("change", reduce); };
  }, []);

  return (
    <footer className="editorial-footer" data-light={theme === "paper" ? "day" : "night"} ref={root} id="about">
      <div className="footer-world" ref={stage} aria-hidden="true" />
      <div className="editorial-footer-content">
        <div className="footer-brand"><a href="#top" className="footer-wordmark"><Flower2 size={27} strokeWidth={1.2} />拾讯<span>signal loom</span></a><p>消息来来往往，<br />总有一些，值得停留。</p></div>
        <nav className="footer-navigation" aria-label="页脚导航"><div><h2>在这里</h2><a href="#reading">阅读资讯 <ArrowUpRight size={12} /></a><a href="#sources">浏览来源 <ArrowUpRight size={12} /></a><a href="/admin">管理中心 <ArrowUpRight size={12} /></a></div><div><h2>关于这一页</h2><p>来自公开 Telegram 频道</p><p>按发布时间，汇集每一条消息</p><a href="https://github.com/appautomaton/delineate" target="_blank" rel="noreferrer">插画与动效 · delineate <ArrowUpRight size={12} /></a></div></nav>
        <p className="footer-signoff">© {new Date().getFullYear()} 拾讯 <span>在喧嚣中，留一处安静。</span></p>
        <div className="footer-view"><span className="footer-scene-label">Alfama, Lisboa <span>38°43′ N · 9°08′ W</span></span><ReadingLightSwitch /><a href="#top" className="footer-top-link" aria-label="回到顶部"><ArrowUp size={17} /></a></div>
      </div>
    </footer>
  );
}
