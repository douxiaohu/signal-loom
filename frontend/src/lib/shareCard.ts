import type { Message } from "../types";
import { cleanMessageContent, formatDate, sourceHue } from "../utils";

/**
 * Renders a message into a polished, theme-aware share image on a <canvas>, with
 * no third-party dependency (the bundle budget rules out html-to-image). Every
 * colour is read live from the active theme's CSS tokens, so the card always
 * matches what the reader sees. Returns a PNG blob plus an object URL for preview
 * and download; the caller revokes the URL.
 */

const TAG_RE = /#[\p{L}\p{N}_]+/gu;
const URL_RE = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;

const FONT =
  '"Geist Variable", "Geist", system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif';

type ShareContent = { title: string; body: string[]; tags: string[] };

/** A simplified take on RichContent: a leading headline, body paragraphs, and hashtags. */
function extractContent(raw: string): ShareContent {
  const cleaned = cleanMessageContent(raw || "").replace(/\r\n/g, "\n");
  const tags = Array.from(new Set(cleaned.match(TAG_RE) || [])).slice(0, 4);

  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean).join(""))
    .map((para) =>
      para
        .replace(URL_RE, (match) => {
          try {
            return new URL(match).hostname.replace(/^www\./, "");
          } catch {
            return match;
          }
        })
        .trim()
    )
    .filter(Boolean);

  if (!paragraphs.length) return { title: "", body: [], tags };

  const first = paragraphs[0];
  const hasHeader = paragraphs.length > 1 && first.length >= 6 && first.length <= 95 && !first.startsWith("http");
  const title = hasHeader ? first : "";
  const body = (hasHeader ? paragraphs.slice(1) : paragraphs).filter(
    (para) => !/^#[\p{L}\p{N}_]+(?:\s+#[\p{L}\p{N}_]+)*$/u.test(para)
  );
  return { title, body, tags };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawZap(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  const points = [
    [13, 2],
    [4.5, 13.5],
    [11, 13.5],
    [10, 22],
    [19.5, 10],
    [13, 10]
  ];
  const s = size / 26;
  const ox = x + (size - 24 * s) / 2;
  const oy = y + (size - 24 * s) / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  points.forEach(([px, py], i) => {
    const X = ox + px * s;
    const Y = oy + py * s;
    if (i) ctx.lineTo(X, Y);
    else ctx.moveTo(X, Y);
  });
  ctx.closePath();
  ctx.fill();
}

export type ShareCardResult = { blob: Blob | null; url: string; width: number; height: number };

export async function renderShareCard(message: Message): Promise<ShareCardResult> {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback;
  const C = {
    bg: token("--background", "#0b0f17"),
    card: token("--card", "#111721"),
    fg: token("--foreground", "#e6ebf3"),
    strong: token("--text-strong", "#f7f9fc"),
    muted: token("--muted-foreground", "#9aa7ba"),
    soft: token("--soft-foreground", "#7d8ba0"),
    border: token("--border", "#232c3c"),
    brandFrom: token("--brand-from", "#22d3ee"),
    brandTo: token("--brand-to", "#6366f1"),
    accent: token("--accent", "rgba(34,211,238,.12)"),
    accentFg: token("--accent-foreground", "#67e8f9"),
    markFg: token("--mark-foreground", "#041822")
  };

  const source = message.chat_title || "未知来源";
  const hue = sourceHue(String(message.chat_id ?? source));
  const { title, body, tags } = extractContent(message.content);

  try {
    await (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
  } catch {
    // fonts.ready is best-effort; fall back to the default stack
  }

  const measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) throw new Error("canvas 2d context unavailable");

  const W = 1080;
  const PAD = 76;
  const CW = W - PAD * 2;
  const AV = 76;
  const titleFont = `650 54px ${FONT}`;
  const bodyFont = `400 33px ${FONT}`;
  const titleLineH = 70;
  const bodyLineH = 52;

  const wrap = (text: string, font: string, maxWidth: number, maxLines: number): string[] => {
    measureCtx.font = font;
    const chars = Array.from(text);
    const lines: string[] = [];
    let line = "";
    let truncated = false;
    for (let i = 0; i < chars.length; i += 1) {
      const next = line + chars[i];
      if (measureCtx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = chars[i];
        if (lines.length >= maxLines) {
          truncated = true;
          break;
        }
      } else {
        line = next;
      }
    }
    // Only ellipsize when text actually overflowed the line budget — not when it
    // merely filled the last line exactly.
    if (!truncated) {
      if (line) lines.push(line);
      return lines;
    }
    let last = lines[maxLines - 1] ?? "";
    while (last && measureCtx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
    return lines;
  };

  const titleLines = title ? wrap(title, titleFont, CW, 3) : [];
  const bodyMax = title ? 7 : 9;
  const bodyLines: string[] = [];
  for (const para of body) {
    if (bodyLines.length >= bodyMax) break;
    bodyLines.push(...wrap(para, bodyFont, CW, bodyMax - bodyLines.length));
    bodyLines.push("");
  }
  while (bodyLines.length && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
  if (!titleLines.length && !bodyLines.length) {
    bodyLines.push(...wrap(`仅包含${message.media_type ? "媒体" : "内容"}`, bodyFont, CW, 1));
  }

  // Height: run the same advances the draw pass uses, then add the footer band.
  let yy = PAD + 14 + AV + 44;
  if (titleLines.length) yy += 26 + titleLines.length * titleLineH + 18;
  yy += bodyLines.reduce((h, line) => h + (line === "" ? 24 : bodyLineH), 0) + 10;
  if (tags.length) yy += 14 + 44 + 16;
  const H = Math.max(840, Math.round(yy + 40 + 112 + 28));

  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.scale(scale, scale);

  // ── Backdrop + ambient glows in the source hue ──────────────────────────
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const glow1 = ctx.createRadialGradient(W * 0.82, H * 0.1, 0, W * 0.82, H * 0.1, W * 0.75);
  glow1.addColorStop(0, `hsla(${hue}, 78%, 56%, 0.18)`);
  glow1.addColorStop(1, `hsla(${hue}, 78%, 56%, 0)`);
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, W, H);
  const glow2 = ctx.createRadialGradient(W * 0.1, H * 0.92, 0, W * 0.1, H * 0.92, W * 0.6);
  glow2.addColorStop(0, `hsla(${(hue + 44) % 360}, 72%, 52%, 0.12)`);
  glow2.addColorStop(1, `hsla(${(hue + 44) % 360}, 72%, 52%, 0)`);
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // ── Panel ───────────────────────────────────────────────────────────────
  const M = 28;
  roundRect(ctx, M, M, W - 2 * M, H - 2 * M, 40);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 48;
  ctx.shadowOffsetY = 24;
  ctx.fillStyle = C.card;
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, M, M, W - 2 * M, H - 2 * M, 40);
  ctx.clip();
  const accent = ctx.createLinearGradient(M, 0, W - M, 0);
  accent.addColorStop(0, C.brandFrom);
  accent.addColorStop(1, C.brandTo);
  ctx.fillStyle = accent;
  ctx.fillRect(M, M, W - 2 * M, 6);
  ctx.restore();

  roundRect(ctx, M, M, W - 2 * M, H - 2 * M, 40);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = C.border;
  ctx.stroke();

  // ── Header ──────────────────────────────────────────────────────────────
  let y = PAD + 14;
  roundRect(ctx, PAD, y, AV, AV, 20);
  const avatar = ctx.createLinearGradient(PAD, y, PAD + AV, y + AV);
  avatar.addColorStop(0, `hsl(${hue}, 55%, 46%)`);
  avatar.addColorStop(1, `hsl(${(hue + 42) % 360}, 58%, 32%)`);
  ctx.fillStyle = avatar;
  ctx.fill();
  const initial = source.slice(0, 1).toUpperCase();
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 38px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initial, PAD + AV / 2, y + AV / 2 + 2);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = C.strong;
  ctx.font = `650 37px ${FONT}`;
  const [nameLine] = wrap(source, `650 37px ${FONT}`, CW - AV - 24, 1);
  ctx.fillText(nameLine || source, PAD + AV + 24, y + 8);
  ctx.fillStyle = C.muted;
  ctx.font = `400 25px ${FONT}`;
  ctx.fillText("Telegram 公开频道 · 频道资讯", PAD + AV + 24, y + 48);
  y += AV + 44;

  // ── Title ───────────────────────────────────────────────────────────────
  if (titleLines.length) {
    roundRect(ctx, PAD, y, 56, 6, 3);
    const kicker = ctx.createLinearGradient(PAD, y, PAD + 56, y);
    kicker.addColorStop(0, C.brandFrom);
    kicker.addColorStop(1, C.brandTo);
    ctx.fillStyle = kicker;
    ctx.fill();
    y += 26;
    ctx.fillStyle = C.strong;
    ctx.font = titleFont;
    for (const line of titleLines) {
      ctx.fillText(line, PAD, y);
      y += titleLineH;
    }
    y += 18;
  }

  // ── Body ────────────────────────────────────────────────────────────────
  ctx.font = bodyFont;
  ctx.fillStyle = C.fg;
  for (const line of bodyLines) {
    if (line === "") {
      y += 24;
      continue;
    }
    ctx.fillText(line, PAD, y);
    y += bodyLineH;
  }
  y += 10;

  // ── Tags ────────────────────────────────────────────────────────────────
  if (tags.length) {
    y += 14;
    let tx = PAD;
    const th = 44;
    const px = 20;
    const gap = 12;
    ctx.font = `550 25px ${FONT}`;
    for (const tag of tags) {
      const tw = ctx.measureText(tag).width + px * 2;
      if (tx + tw > W - PAD) break;
      roundRect(ctx, tx, y, tw, th, 22);
      ctx.fillStyle = C.accent;
      ctx.fill();
      ctx.fillStyle = C.accentFg;
      ctx.textBaseline = "middle";
      ctx.fillText(tag, tx + px, y + th / 2 + 1);
      ctx.textBaseline = "top";
      tx += tw + gap;
    }
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  const fy = H - 124;
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, fy);
  ctx.lineTo(W - PAD, fy);
  ctx.stroke();

  const LM = 46;
  const ly = fy + 26;
  roundRect(ctx, PAD, ly, LM, LM, 14);
  const logo = ctx.createLinearGradient(PAD, ly, PAD + LM, ly + LM);
  logo.addColorStop(0, C.brandFrom);
  logo.addColorStop(1, C.brandTo);
  ctx.fillStyle = logo;
  ctx.fill();
  drawZap(ctx, PAD, ly, LM, C.markFg);

  ctx.textBaseline = "top";
  ctx.fillStyle = C.strong;
  ctx.font = `650 27px ${FONT}`;
  ctx.fillText("频道资讯", PAD + LM + 18, ly + 2);
  ctx.fillStyle = C.soft;
  ctx.font = `400 22px ${FONT}`;
  ctx.fillText("douxiaohu.duckdns.org", PAD + LM + 18, ly + 33);

  ctx.textAlign = "right";
  ctx.fillStyle = C.soft;
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText(formatDate(message.message_time), W - PAD, ly + 14);
  ctx.textAlign = "left";

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  const url = blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/png");
  return { blob, url, width: W, height: H };
}
