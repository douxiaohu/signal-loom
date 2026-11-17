import { useEffect, useRef, useState } from "react";
import { ArrowDown, RotateCcw } from "lucide-react";
import Botanical from "./Botanical";

// The crew owns only this static sheet. React owns the search, filters and live messages.
const sheet = `<section data-section class="intro-sheet"><div class="wrap">
  <p class="intro-eyebrow" data-build="type">A LITTLE SIGNAL, EVERY DAY</p>
  <h2 class="intro-title" data-build="headline">世界在发生，\n消息在这里相遇。</h2>
  <p class="intro-description" data-build="type">从公开频道拾取值得留意的声音。少一点切换，多一点看见，给每天的阅读留一处安静的角落。</p>
  <div class="intro-tags" data-build="slots"><span>公开频道</span><span>按时间汇集</span><span>自由阅读</span></div>
</div></section>`;
// Stable identity prevents a React render from replacing the crew's in-progress DOM.
const sheetContent = { __html: sheet };

export default function AssemblyIntro() {
  const root = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState(0);

  useEffect(() => {
    const el = root.current;
    if (!el || !window.IntersectionObserver) return;
    let visible = false;
    const sync = () => el.classList.toggle("is-active", visible && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
    observer.observe(el);
    document.addEventListener("visibilitychange", sync);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", sync); };
  }, []);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const sheetEl = el.querySelector<HTMLElement>(".intro-copy")!;
    sheetEl.innerHTML = sheet;
    // Unsupported browsers and readers asking for less motion receive the complete page.
    if (!window.matchMedia || !window.IntersectionObserver || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let disposed = false;
    let dispose = () => {};
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => { dispose(); sheetEl.innerHTML = sheet; el.classList.remove("is-assembling"); };
    motion.addEventListener("change", finish);
    void import("./assembly-runtime").then(async ({ mountAssembly }) => {
      await document.fonts.ready;
      if (disposed || motion.matches) return;
      el.classList.add("is-assembling");
      dispose = mountAssembly(el, () => { if (!disposed) el.classList.remove("is-assembling"); });
    }).catch(() => { if (!disposed) finish(); });
    return () => { disposed = true; motion.removeEventListener("change", finish); dispose(); el.classList.remove("is-assembling"); };
  }, [run]);

  return (
    <div className="editorial-intro" ref={root} id="top">
      <div className="intro-ruler" aria-hidden="true">{Array.from({ length: 13 }, (_, index) => <span key={index} style={{ left: `${index * 100}px` }}>{index * 100}</span>)}</div>
      <div className="intro-copy" dangerouslySetInnerHTML={sheetContent} />
      <div className="intro-garden" aria-hidden="true">
        <div className="garden-circle" />
        <span className="garden-note">让好消息，慢慢生长。</span>
        <Botanical species="lavender" className="intro-lavender" />
        <Botanical species="olive" className="intro-olive" />
        <span className="garden-specimen">FIG. 01 — A GARDEN OF SIGNALS</span>
        <svg className="garden-butterfly" viewBox="0 0 50 40"><path d="M25 27C-3 13 8-5 22 10l3 13C25-8 53 3 40 19L27 28M25 22l-2 13" fill="var(--butterfly)" stroke="var(--garden-ink)" strokeWidth="1.1" /></svg>
      </div>
      <div className="intro-bottom">
        <a href="#reading" className="intro-read">开始阅读 <ArrowDown size={15} aria-hidden="true" /></a>
        <button type="button" className="intro-replay" onClick={() => setRun((value) => value + 1)} aria-label="重播页面组装动画"><RotateCcw size={12} aria-hidden="true" />重绘这一页</button>
        <span className="intro-edition">THE DAILY COLLECTION / 频道手记</span>
      </div>
      <div className="marks" aria-hidden="true" />
      <div className="hands" aria-hidden="true" />
    </div>
  );
}
