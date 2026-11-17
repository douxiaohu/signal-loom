import { useEffect, useRef } from "react";

export default function Botanical({ species, className = "" }: { species: "lavender" | "olive"; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el || !window.IntersectionObserver) return;
    const controller = new AbortController();
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let started = false;
    let animations: Animation[] = [];
    const settle = () => { animations.forEach((animation) => animation.finish()); };
    const observer = new IntersectionObserver(async ([entry]) => {
      el.classList.toggle("is-visible", entry.isIntersecting);
      animations.forEach((animation) => entry.isIntersecting && !document.hidden ? animation.play() : animation.pause());
      if (!entry.isIntersecting || started) return;
      started = true;
      try {
        const response = await fetch(`/artwork/${species}.svg`, { signal: controller.signal });
        if (!response.ok) return;
        const svg = await response.text();
        if (controller.signal.aborted) return;
        el.innerHTML = svg;
        if (motion?.matches || !el.animate) return;
        animations = [...el.querySelectorAll<SVGElement>(".gp")].map((part) => {
          part.style.transformOrigin = (part.dataset.o || "0 0").split(" ").map((n) => `${n}px`).join(" ");
          const delay = Number(part.dataset.g || 0) * 1300;
          return part.animate([{ opacity: 0, transform: "scale(0.1)" }, { opacity: 1, transform: "scale(1)" }], { duration: 850, delay, fill: "backwards", easing: "cubic-bezier(.16,1,.3,1)" });
        });
      } catch { /* Optional local illustration never prevents reading. */ }
    }, { rootMargin: "40px" });
    const visibility = () => animations.forEach((animation) => document.hidden ? animation.pause() : el.classList.contains("is-visible") && animation.play());
    observer.observe(el);
    document.addEventListener("visibilitychange", visibility);
    motion?.addEventListener("change", settle);
    return () => { controller.abort(); observer.disconnect(); animations.forEach((animation) => animation.cancel()); motion?.removeEventListener("change", settle); document.removeEventListener("visibilitychange", visibility); };
  }, [species]);
  return <div ref={root} className={`botanical botanical-${species} ${className}`} aria-hidden="true" />;
}
