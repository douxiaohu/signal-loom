import { Clock } from "../../vendor/delineate/hand/clock";
import { Hand } from "../../vendor/delineate/hand/hand";
import { Marks } from "../../vendor/delineate/hand/marks";
import { stage } from "../../vendor/delineate/hand/space";

// A filter revisit preserves a card's completed drawing. Updated content gets a new run.
const completed = new Map<string, string>();
const TEXT = ".pub-card-source, .pub-sender, .pub-card-time, .pub-rich-heading > span, .pub-rich-line, .pub-media-note";

/** Reveals the real glyphs with a visual mask; never rewrites React's text or link nodes. */
function writing(el: HTMLElement) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement?.closest("svg")) nodes.push(walker.currentNode as Text);
  }
  const text = nodes.map((node) => node.data).join("");
  const range = document.createRange();
  const reveal = (count: number) => {
    if (!nodes.length || count <= 0) { el.style.clipPath = "inset(0 100% 0 0)"; return null; }
    range.setStart(nodes[0], 0);
    let rest = count;
    for (const node of nodes) {
      const end = Math.min(rest, node.length);
      range.setEnd(node, end);
      rest -= end;
      if (rest <= 0) break;
    }
    const rect = el.getBoundingClientRect();
    const boxes = [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
    const paths = boxes.map((box) => {
      const x = (box.left - rect.left - 1).toFixed(1);
      const y = (box.top - rect.top - 2).toFixed(1);
      return `M${x} ${y}h${(box.width + 2).toFixed(1)}v${(box.height + 4).toFixed(1)}h-${(box.width + 2).toFixed(1)}Z`;
    });
    el.style.clipPath = paths.length ? `path('${paths.join("")}')` : "inset(0 100% 0 0)";
    return boxes[boxes.length - 1] || null;
  };
  return { el, text, reveal };
}

export function mountMessageAssembly(root: HTMLElement, id: string, version: string): () => void {
  if (!root.closest(".public-page") || completed.get(id) === version) {
    root.dataset.assemblyState = "complete";
    return () => {};
  }
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let started = false;
  let preparing = false;
  let stopped = false;
  let visible = false;
  let clock: Clock | undefined;
  let deadline = 0;
  let layer: HTMLDivElement | undefined;
  const originalStyles = new Map<HTMLElement, { clipPath: string; opacity: string }>();
  const animations: Animation[] = [];
  root.dataset.assemblyState = "waiting";

  const remember = (el: HTMLElement) => {
    originalStyles.set(el, { clipPath: el.style.clipPath, opacity: el.style.opacity });
  };
  const finish = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(deadline);
    clock?.sleep();
    observer.disconnect();
    animations.forEach((animation) => animation.cancel());
    originalStyles.forEach((styles, el) => { el.style.clipPath = styles.clipPath; el.style.opacity = styles.opacity; });
    layer?.remove();
    root.classList.remove("message-assembly-stage");
    root.dataset.assemblyState = "complete";
    if (started) {
      completed.delete(id);
      completed.set(id, version);
      if (completed.size > 512) completed.delete(completed.keys().next().value!);
    }
    ["pointerdown", "focusin", "keydown", "copy"].forEach((event) => root.removeEventListener(event, finish, true));
    window.removeEventListener("resize", finish);
    document.removeEventListener("visibilitychange", visibility);
    motion.removeEventListener("change", finish);
  };
  const visibility = () => {
    if (document.hidden) clock?.sleep();
    else if (!stopped && visible) clock?.wake();
  };

  async function build() {
    if (preparing) return;
    preparing = true;
    await document.fonts.ready;
    preparing = false;
    if (stopped || started || !visible || motion.matches) return;
    const targets = [...root.querySelectorAll<HTMLElement>(TEXT)].filter((el) => {
      const box = el.getBoundingClientRect();
      const fold = el.closest(".pub-rich-fold.is-clipped")?.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && (!fold || box.top < fold.bottom);
    });
    if (!targets.length) { finish(); return; }
    started = true;
    root.classList.add("message-assembly-stage");
    root.dataset.assemblyState = "building";
    // Measure all text before changing any visual state. Text flow and card height stay fixed.
    const words = targets.map((el) => { remember(el); return writing(el); });
    words.forEach((word) => word.reveal(0));
    const media = root.querySelector<HTMLElement>(".pub-media");
    if (media) { remember(media); media.style.opacity = "0"; }
    layer = document.createElement("div");
    layer.className = "message-assembly-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.innerHTML = '<div class="marks"></div><div class="hands"></div>';
    root.append(layer);
    const space = stage(root);
    clock = new Clock();
    clock.rate = 2;
    deadline = window.setTimeout(finish, 3200);
    const timer = clock;
    const marks = new Marks(layer.querySelector(".marks")!, { rulers: false });
    const hands = ["type", "layout"].map((name, index) => new Hand(timer, layer!.querySelector(".hands")!, {
      name: `${name}-${id}`, colour: `var(--c-${index ? "green" : "blue"})`, seed: Number(id) * 13 + index + 2026,
      start: { x: 8 + index * Math.max(32, root.clientWidth - 40), y: 18 },
      style: { tempo: 0.24, curl: 0.05, scatter: 1 }, typist: { pace: 125, slips: 0 }
    }));
    timer.each(() => marks.draw());
    const drawFrame = async (hand: Hand, el: HTMLElement) => {
      const box = space.box(el);
      hand.tool = "cross";
      await hand.reachPoint({ x: box.x, y: box.y }, 3);
      if (stopped) return null;
      const frame = marks.frame();
      const origin = { ...hand.pos };
      await hand.press();
      if (stopped) return null;
      const stopFrame = timer.each(() => frame.set({ x: origin.x, y: origin.y, w: hand.pos.x - origin.x, h: hand.pos.y - origin.y }));
      await hand.reachPoint({ x: box.x + box.w, y: box.y + box.h }, 3);
      stopFrame();
      if (stopped) return null;
      frame.set(box);
      hand.release();
      return frame;
    };
    // One hand types the source then the body; the other sets metadata and the media frame.
    const body = words.filter(({ el }) => !el.matches(".pub-sender, .pub-card-time"));
    const metadata = words.filter(({ el }) => el.matches(".pub-sender, .pub-card-time"));
    const type = async (hand: Hand, jobs: typeof words) => {
      for (const word of jobs) {
        if (stopped) return;
        const frame = await drawFrame(hand, word.el);
        if (stopped) return;
        hand.tool = "text";
        const box = space.box(word.el);
        await hand.reachPoint({ x: box.x + 3, y: box.y + Math.min(box.h, 22) / 2 }, 3);
        if (stopped) return;
        const caret = document.createElement("i");
        caret.className = "message-type-caret";
        caret.style.background = hand.colour;
        layer!.append(caret);
        // Keep long posts brisk; their complete, selectable text remains in the DOM throughout.
        const sample = word.text.slice(0, 600);
        await hand.type(sample, (shown) => {
          if (stopped) return;
          const last = word.reveal(Math.ceil(shown.length * word.text.length / sample.length));
          if (last) {
            const point = space.point(last.right, last.top);
            caret.style.transform = `translate(${point.x}px,${point.y}px)`;
            caret.style.height = `${last.height}px`;
          }
        }, Math.max(1, sample.length / 190));
        if (stopped) return;
        caret.remove();
        word.el.style.clipPath = originalStyles.get(word.el)!.clipPath;
        frame?.remove();
      }
    };
    const picture = async () => {
      // Show the actual image first; metadata typing continues afterwards.
      if (!media) { await type(hands[1], metadata); return; }
      if (stopped) return;
      const frame = await drawFrame(hands[1], media);
      if (stopped) return;
      media.style.opacity = originalStyles.get(media)!.opacity;
      animations.push(media.animate([{ opacity: 0, clipPath: "inset(0 100% 0 0)" }, { opacity: 1, clipPath: "inset(0)" }], { duration: 160, easing: "ease-out" }));
      await timer.wait(0.4);
      frame?.remove();
      await type(hands[1], metadata);
    };
    try { await Promise.all([type(hands[0], body), picture()]); }
    finally { finish(); }
  }

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (!visible && started) { finish(); return; }
    if (visible && !started && !stopped) void build().catch(finish);
  }, { rootMargin: "-80px 0px -24px 0px" });
  ["pointerdown", "focusin", "keydown", "copy"].forEach((event) => root.addEventListener(event, finish, true));
  window.addEventListener("resize", finish);
  document.addEventListener("visibilitychange", visibility);
  motion.addEventListener("change", finish);
  if (motion.matches) finish();
  else observer.observe(root);
  return finish;
}
