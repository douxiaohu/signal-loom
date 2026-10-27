import { useEffect, useState } from "react";

import "./CountUp.css";

type CountUpProps = {
  to: number;
  from?: number;
  duration?: number;
  className?: string;
};

const countFormatter = new Intl.NumberFormat("zh-CN");

function prefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function CountUp({ to, from = 0, duration = 0.85, className = "" }: CountUpProps) {
  const jump = prefersReducedMotion();
  const [value, setValue] = useState(jump ? to : from);

  useEffect(() => {
    if (jump) {
      setValue(to);
      return;
    }
    const origin = from;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min((now - start) / (duration * 1000), 1);
      const eased = 1 - (1 - progress) ** 3;
      setValue(origin + (to - origin) * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [to, from, duration, jump]);

  return <span className={className ? `count-up ${className}` : "count-up"}>{countFormatter.format(Math.round(value))}</span>;
}

export function CountUpPair({ left, right, duration = 0.85 }: { left: number; right: number; duration?: number }) {
  const jump = prefersReducedMotion();
  const [progress, setProgress] = useState(jump ? 1 : 0);

  useEffect(() => {
    if (jump) {
      setProgress(1);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = Math.min((now - start) / (duration * 1000), 1);
      setProgress(1 - (1 - next) ** 3);
      if (next < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [left, right, duration, jump]);

  const label = `${countFormatter.format(Math.round(left * progress))} / ${countFormatter.format(Math.round(right * progress))}`;
  return <span className="count-up">{label}</span>;
}
