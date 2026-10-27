import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";

import "./ClickSpark.css";

type Spark = { x: number; y: number; angle: number; startTime: number };

type ClickSparkProps = {
  children?: ReactNode;
  sparkColor?: string;
  sparkSize?: number;
  sparkRadius?: number;
  sparkCount?: number;
  duration?: number;
};

function motionReduced() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function readSparkColor(explicit?: string) {
  if (explicit) return explicit;
  const styles = getComputedStyle(document.documentElement);
  const admin = document.querySelector(".admin-app, .login-shell");
  const variable = admin ? "--admin-brand" : "--brand";
  return styles.getPropertyValue(variable).trim() || styles.getPropertyValue("--brand").trim() || "#1f4ed8";
}

export default function ClickSpark({
  children,
  sparkColor,
  sparkSize = 8,
  sparkRadius = 16,
  sparkCount = 8,
  duration = 420
}: ClickSparkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sparksRef = useRef<Spark[]>([]);
  const frameRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * ratio);
      canvas.height = Math.floor(window.innerHeight * ratio);
      try {
        canvas.getContext("2d")?.setTransform(ratio, 0, 0, ratio, 0, 0);
      } catch {
        /* jsdom has no 2d context */
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(frameRef.current);
    };
  }, []);

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if (motionReduced()) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      context = null;
    }
    if (!context) return;
    const rect = canvas.getBoundingClientRect();
    const now = performance.now();
    const originX = event.clientX - rect.left;
    const originY = event.clientY - rect.top;
    sparksRef.current.push(
      ...Array.from({ length: sparkCount }, (_, index) => ({
        x: originX,
        y: originY,
        angle: (Math.PI * 2 * index) / sparkCount,
        startTime: now
      }))
    );
    if (frameRef.current) return;
    const color = readSparkColor(sparkColor);
    const draw = (timestamp: number) => {
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);
      sparksRef.current = sparksRef.current.filter((spark) => {
        const elapsed = timestamp - spark.startTime;
        if (elapsed >= duration) return false;
        const progress = elapsed / duration;
        const eased = progress * (2 - progress);
        const distance = eased * sparkRadius;
        const length = sparkSize * (1 - eased);
        context.strokeStyle = color;
        context.lineWidth = 1.6;
        context.beginPath();
        context.moveTo(spark.x + distance * Math.cos(spark.angle), spark.y + distance * Math.sin(spark.angle));
        context.lineTo(
          spark.x + (distance + length) * Math.cos(spark.angle),
          spark.y + (distance + length) * Math.sin(spark.angle)
        );
        context.stroke();
        return true;
      });
      frameRef.current = sparksRef.current.length ? requestAnimationFrame(draw) : 0;
    };
    frameRef.current = requestAnimationFrame(draw);
  }

  return (
    <div className="click-spark" onClick={handleClick}>
      <canvas ref={canvasRef} aria-hidden="true" />
      {children}
    </div>
  );
}
