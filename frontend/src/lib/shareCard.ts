import type { Message } from "../types";
import { cleanMessageContent, formatDate, sourceHue } from "../utils";

/**
 * Renders a message into a polished, theme-aware share image on a <canvas>, with
 * no third-party dependency (the bundle budget rules out html-to-image). The card
 * leads with the post's own photo (served same-origin from the app's media cache,
 * so it never taints the canvas; a remote legacy URL fails cleanly and falls back
 * to a source-tinted cover). Every colour is read live from the active theme's CSS
 * tokens. Returns a PNG blob plus an object URL for preview and download.
 */

const TAG_RE = /#[\p{L}\p{N}_]+/gu;
const URL_RE = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
const NON_IMAGE_KINDS = ["video", "animation", "document", "file", "audio", "voice", "sticker"];

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

/** The first still-image attachment, if any — used as the card's hero. */
function firstImageUrl(message: Message): string | null {
  const items = message.media_items?.length
    ? message.media_items
    : (message.media_urls || []).map((url) => ({ url, kind: message.media_type || "image", role: "media" }));
  const messageType = (message.media_type || "").toLowerCase();
  for (const item of items) {
    const kind = (item.kind || "").toLowerCase();
    if (["image", "photo"].includes(kind)) return item.url;
    if (!NON_IMAGE_KINDS.includes(kind) && ["image", "photo"].includes(messageType)) return item.url;
  }
  return null;
}

/** Loads the hero image through CORS so the canvas stays exportable; a remote URL
 *  without CORS, or a slow one, resolves to null instead of tainting or hanging. */
function loadHeroImage(message: Message): Promise<HTMLImageElement | null> {
  const src = firstImageUrl(message);
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    let settled = false;
    const finish = (value: HTMLImageElement | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    img.onload = () => finish(img.naturalWidth > 0 ? img : null);
    img.onerror = () => finish(null);
    window.setTimeout(() => finish(null), 6000);
    img.src = src;
  });
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

/** A path with rounded top corners and square bottom corners (for the cover). */
function roundRectTop(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

/** Draws an image into a box with object-fit: cover (centre crop). */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const imgRatio = img.naturalWidth / img.naturalHeight;
  const boxRatio = w / h;
  let sx = 0;
  let sy = 0;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  if (imgRatio > boxRatio) {
    sw = sh * boxRatio;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = sw / boxRatio;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
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
  const hero = await loadHeroImage(message);

  try {
    await (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
  } catch {
    // fonts.ready is best-effort; fall back to the default stack
  }

  const measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) throw new Error("canvas 2d context unavailable");

  const W = 1080;
  const M = 28;
  const PW = W - 2 * M;
  const PAD = 72;
  const CW = W - PAD * 2;
  const coverH = hero ? 604 : 240;
  const titleFont = `650 50px ${FONT}`;
  const bodyFont = `400 32px ${FONT}`;
  const titleLineH = 66;
  const bodyLineH = 50;

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
  const bodyMax = titleLines.length ? 4 : 6;
  const bodyLines: string[] = [];
  for (const para of body) {
    if (bodyLines.length >= bodyMax) break;
    bodyLines.push(...wrap(para, bodyFont, CW, bodyMax - bodyLines.length));
    bodyLines.push("");
  }
  while (bodyLines.length && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
  if (!titleLines.length && !bodyLines.length) {
    bodyLines.push(...wrap(hero ? "查看原文了解更多" : `仅包含${message.media_type || "内容"}`, bodyFont, CW, 1));
  }

  // Height: start below the cover, then the same advances the draw pass uses.
  let yy = M + coverH + 40;
  if (titleLines.length) yy += 24 + titleLines.length * titleLineH + 16;
  yy += bodyLines.reduce((h, line) => h + (line === "" ? 22 : bodyLineH), 0);
  if (tags.length) yy += 16 + 44 + 10;
  const H = Math.round(yy + 34 + 96 + M);

  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.scale(scale, scale);

  // ── Backdrop + ambient glow ─────────────────────────────────────────────
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.12, H * 0.92, 0, W * 0.12, H * 0.92, W * 0.7);
  glow.addColorStop(0, `hsla(${(hue + 40) % 360}, 72%, 52%, 0.14)`);
  glow.addColorStop(1, `hsla(${(hue + 40) % 360}, 72%, 52%, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // ── Panel ───────────────────────────────────────────────────────────────
  roundRect(ctx, M, M, PW, H - 2 * M, 40);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 48;
  ctx.shadowOffsetY = 24;
  ctx.fillStyle = C.card;
  ctx.fill();
  ctx.restore();

  // ── Cover: the hero photo, or a source-tinted gradient ──────────────────
  ctx.save();
  roundRectTop(ctx, M, M, PW, coverH, 40);
  ctx.clip();
  if (hero) {
    drawCover(ctx, hero, M, M, PW, coverH);
  } else {
    const cover = ctx.createLinearGradient(M, M, M + PW, M + coverH);
    cover.addColorStop(0, `hsl(${hue}, 58%, 42%)`);
    cover.addColorStop(1, `hsl(${(hue + 46) % 360}, 60%, 30%)`);
    ctx.fillStyle = cover;
    ctx.fillRect(M, M, PW, coverH);
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.font = `700 230px ${FONT}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(source.slice(0, 1).toUpperCase(), W - M - 36, M + coverH - 36);
    ctx.textAlign = "left";
  }
  // bottom scrim so the source line stays legible over any photo
  const scrim = ctx.createLinearGradient(0, M + coverH - 240, 0, M + coverH);
  scrim.addColorStop(0, "rgba(6,10,18,0)");
  scrim.addColorStop(1, "rgba(6,10,18,0.74)");
  ctx.fillStyle = scrim;
  ctx.fillRect(M, M + coverH - 240, PW, 240);
  ctx.restore();

  // ── Source identity, overlaid on the cover ──────────────────────────────
  const idY = M + coverH - 96;
  const AV = 64;
  roundRect(ctx, PAD, idY, AV, AV, 16);
  const avatar = ctx.createLinearGradient(PAD, idY, PAD + AV, idY + AV);
  avatar.addColorStop(0, `hsl(${hue}, 60%, 50%)`);
  avatar.addColorStop(1, `hsl(${(hue + 42) % 360}, 60%, 36%)`);
  ctx.fillStyle = avatar;
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 32px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(source.slice(0, 1).toUpperCase(), PAD + AV / 2, idY + AV / 2 + 2);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  ctx.font = `650 36px ${FONT}`;
  const [nameLine] = wrap(source, `650 36px ${FONT}`, CW - AV - 22, 1);
  ctx.fillText(nameLine || source, PAD + AV + 20, idY + 26);
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.font = `400 23px ${FONT}`;
  ctx.fillText("Telegram 公开频道 · 频道资讯", PAD + AV + 20, idY + 56);

  // ── Content ─────────────────────────────────────────────────────────────
  ctx.textBaseline = "top";
  let y = M + coverH + 40;

  if (titleLines.length) {
    roundRect(ctx, PAD, y, 56, 6, 3);
    const kicker = ctx.createLinearGradient(PAD, y, PAD + 56, y);
    kicker.addColorStop(0, C.brandFrom);
    kicker.addColorStop(1, C.brandTo);
    ctx.fillStyle = kicker;
    ctx.fill();
    y += 24;
    ctx.fillStyle = C.strong;
    ctx.font = titleFont;
    for (const line of titleLines) {
      ctx.fillText(line, PAD, y);
      y += titleLineH;
    }
    y += 16;
  }

  ctx.font = bodyFont;
  ctx.fillStyle = C.fg;
  for (const line of bodyLines) {
    if (line === "") {
      y += 22;
      continue;
    }
    ctx.fillText(line, PAD, y);
    y += bodyLineH;
  }

  if (tags.length) {
    y += 16;
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
  const fy = H - M - 86;
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, fy);
  ctx.lineTo(W - PAD, fy);
  ctx.stroke();

  const LM = 46;
  const ly = fy + 24;
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
