import type { MediaItem, Message } from "../types";
import { cleanMessageContent, formatDate, sourceHue } from "../utils";

const FONT = '"Geist Variable", system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif';
const NON_IMAGES = new Set(["video", "animation", "document", "file", "audio", "voice", "sticker"]);
const WIDTH = 1080;
const PAGE_HEIGHT = 2600;
const SCALE = 1.5;
const PAD = 64;
const CONTENT_WIDTH = WIDTH - PAD * 2;
const FOOTER = 104;
const BOTTOM = PAGE_HEIGHT - PAD - FOOTER;
const BODY_FONT = `400 32px ${FONT}`;
const BODY_LINE = 50;
// Share PNGs must point to the public site even when generated from a local preview.
const WEBSITE_URL = "https://douxiaohu.duckdns.org";

export type ShareCardPage = { blob: Blob; url: string; width: number; height: number };
export type ShareCardResult = { pages: ShareCardPage[]; imageCount: number; failedImages: number };

/** Every still photo, in attachment order. Originals take priority over thumbnails. */
function imageItems(message: Message): MediaItem[] {
  const items = message.media_items?.length ? message.media_items : (message.media_urls || []).map((url) => ({ url, kind: message.media_type || "image", role: "media" }));
  return items.filter((item) => {
    const kind = (item.kind || "").toLowerCase();
    return ["image", "photo"].includes(kind) || (!NON_IMAGES.has(kind) && ["image", "photo"].includes(message.media_type || ""));
  });
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Share rendering cancelled", "AbortError");
}

function loadImage(src: string, signal?: AbortSignal): Promise<HTMLImageElement | null> {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    let settled = false;
    const finish = (value: HTMLImageElement | null, cancelled = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      img.onload = img.onerror = null;
      if (!value) img.src = "";
      if (cancelled) reject(new DOMException("Share rendering cancelled", "AbortError"));
      else resolve(value);
    };
    const cancel = () => finish(null, true);
    const timeout = window.setTimeout(() => finish(null), 5000);
    img.onload = () => finish(img.naturalWidth && img.naturalHeight ? img : null);
    img.onerror = () => finish(null);
    signal?.addEventListener("abort", cancel, { once: true });
    img.src = src;
  });
}

async function loadAttachment(item: MediaItem, signal?: AbortSignal) {
  for (const src of [...new Set([item.original_url, item.url].filter((value): value is string => Boolean(value)))]) {
    const image = await loadImage(src, signal);
    if (image) return image;
  }
  return null;
}

/** Real fonts determine every line; no body/title line budget and no ellipsized post. */
function wrap(ctx: CanvasRenderingContext2D, text: string, font: string, width: number): string[] {
  ctx.font = font;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const char of Array.from(paragraph)) {
      if (line && ctx.measureText(line + char).width > width) {
        lines.push(line);
        line = char;
      } else line += char;
    }
    lines.push(line);
  }
  return lines;
}

/** Renders bounded PNG pages. Paragraphs flow across pages and every photo is contained. */
export async function renderShareCard(message: Message, { signal }: { signal?: AbortSignal } = {}): Promise<ShareCardResult> {
  await document.fonts?.ready;
  abortIfNeeded(signal);
  const tokens = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => tokens.getPropertyValue(name).trim() || fallback;
  const palette = {
    paper: color("--card", "#fcfbf7"), ink: color("--foreground", "#363930"),
    title: color("--text-strong", "#292d25"), soft: color("--muted-foreground", "#62665a"),
    rule: color("--border", "#dedfd4"), wash: color("--surface-muted", "#efefe5"),
    accent: color("--link", "#526b44")
  };
  const source = message.chat_title || "未知来源";
  const attachments = imageItems(message);
  const hue = sourceHue(String(message.chat_id));
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("Canvas unavailable");
  const nameFont = `600 34px ${FONT}`;
  const sourceLines = wrap(measure, source, nameFont, CONTENT_WIDTH - 96);
  const headerLines = sourceLines.slice(0, 2);
  if (sourceLines.length > 2) headerLines[1] = headerLines[1].slice(0, -1) + "…";
  const headerBottom = PAD + Math.max(72, headerLines.length * 44 + 32) + 26;
  const contentTop = headerBottom + 36;
  const pages: ShareCardPage[] = [];
  let failedImages = 0;
  let y = contentTop;

  function newPage() {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH * SCALE;
    canvas.height = PAGE_HEIGHT * SCALE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = palette.paper;
    ctx.fillRect(0, 0, WIDTH, PAGE_HEIGHT);
    ctx.fillStyle = `hsl(${hue} 30% 42%)`;
    ctx.beginPath();
    ctx.arc(PAD + 34, PAD + 36, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 30px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(Array.from(source)[0], PAD + 34, PAD + 36);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = palette.title;
    ctx.font = nameFont;
    headerLines.forEach((line, index) => ctx.fillText(line, PAD + 96, PAD + index * 44));
    ctx.fillStyle = palette.soft;
    ctx.font = `400 23px ${FONT}`;
    ctx.fillText("Telegram 公开频道 · " + formatDate(message.message_time), PAD + 96, PAD + headerLines.length * 44 + 5);
    ctx.fillStyle = palette.rule;
    ctx.fillRect(PAD, headerBottom, CONTENT_WIDTH, 1);
    return { canvas, ctx };
  }

  let page = newPage();
  async function flush() {
    abortIfNeeded(signal);
    const height = Math.min(PAGE_HEIGHT, Math.ceil(y + FOOTER + PAD));
    const fy = height - PAD - 68;
    page.ctx.fillStyle = palette.rule;
    page.ctx.fillRect(PAD, fy - 22, CONTENT_WIDTH, 1);
    page.ctx.fillStyle = palette.accent;
    page.ctx.font = `600 27px ${FONT}`;
    page.ctx.textBaseline = "top";
    page.ctx.textAlign = "left";
    page.ctx.fillText("频道资讯", PAD, fy);
    page.ctx.fillStyle = palette.soft;
    page.ctx.font = `400 22px ${FONT}`;
    page.ctx.fillText(WEBSITE_URL, PAD, fy + 36);
    page.ctx.textAlign = "right";
    page.ctx.fillText(`第 ${pages.length + 1} 页${attachments.length ? ` · ${attachments.length} 张图片` : ""}`, WIDTH - PAD, fy + 18);
    // Crop only unused page space, never the source photo. Release raster memory per page.
    const output = document.createElement("canvas");
    output.width = page.canvas.width;
    output.height = Math.ceil(height * SCALE);
    const outputCtx = output.getContext("2d");
    if (!outputCtx) throw new Error("Canvas unavailable");
    outputCtx.drawImage(page.canvas, 0, 0);
    page.canvas.width = page.canvas.height = 0;
    const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/png"));
    output.width = output.height = 0;
    abortIfNeeded(signal);
    if (!blob) throw new Error("PNG generation failed");
    pages.push({ blob, url: URL.createObjectURL(blob), width: WIDTH, height });
  }
  async function ensureRoom(height: number) {
    if (y + height <= BOTTOM) return;
    await flush();
    page = newPage();
    y = contentTop;
  }
  async function paragraph(text: string, heading = false) {
    const quote = !heading && (/^[“"「『【]/.test(text) || text.includes("转发自"));
    const font = heading ? `600 48px ${FONT}` : BODY_FONT;
    const lineHeight = heading ? 68 : BODY_LINE;
    const inset = quote ? 26 : 0;
    const lines = wrap(measure!, text, font, CONTENT_WIDTH - inset * 2);
    for (const line of lines) {
      await ensureRoom(lineHeight + 10);
      const ctx = page.ctx;
      if (quote) {
        ctx.fillStyle = palette.wash;
        ctx.fillRect(PAD, y - 5, CONTENT_WIDTH, lineHeight + 10);
        ctx.fillStyle = palette.accent;
        ctx.fillRect(PAD, y - 5, 4, lineHeight + 10);
      }
      ctx.font = font;
      ctx.fillStyle = heading ? palette.title : palette.ink;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(line, PAD + inset, y);
      y += lineHeight;
    }
    y += heading ? 24 : 20;
  }

  try {
    if (sourceLines.length > 2) await paragraph("来源：" + source);
    const blocks = cleanMessageContent(message.content).replace(/\r\n/g, "\n").split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
    for (const [index, text] of blocks.entries()) {
      const heading = index === 0 && blocks.length > 1 && text.length <= 180 && !/^[“"「『【]|https?:\/\//.test(text);
      await paragraph(text, heading);
    }
    if (!blocks.length && !attachments.length) await paragraph("仅包含媒体内容，请查看原文。");
    // Load and draw one source at a time: a large album does not retain every decoded photo.
    for (const [index, item] of attachments.entries()) {
      abortIfNeeded(signal);
      const image = await loadAttachment(item, signal);
      try {
        const limit = BOTTOM - contentTop - 58;
        const idealHeight = image ? Math.min(image.naturalHeight * CONTENT_WIDTH / image.naturalWidth, limit) : 150;
        if (BOTTOM - y - 58 < Math.min(600, idealHeight * 0.7)) await ensureRoom(idealHeight + 58);
        const available = Math.floor(Math.min(limit, BOTTOM - y - 58));
        const factor = image ? Math.min(CONTENT_WIDTH / image.naturalWidth, available / image.naturalHeight) : 1;
        const width = image ? image.naturalWidth * factor : CONTENT_WIDTH;
        const height = image ? image.naturalHeight * factor : 150;
        await ensureRoom(height + 58);
        page.ctx.font = `400 22px ${FONT}`;
        page.ctx.fillStyle = palette.soft;
        page.ctx.textAlign = "left";
        page.ctx.textBaseline = "top";
        page.ctx.fillText(`图片 ${index + 1} / ${attachments.length}`, PAD, y);
        y += 36;
        if (image) {
          // Five-argument drawImage scales the complete image; there is no source crop.
          page.ctx.drawImage(image, PAD + (CONTENT_WIDTH - width) / 2, y, width, height);
        } else {
          failedImages++;
          page.ctx.fillStyle = palette.wash;
          page.ctx.fillRect(PAD, y, CONTENT_WIDTH, height);
          page.ctx.fillStyle = palette.soft;
          page.ctx.font = BODY_FONT;
          page.ctx.fillText(`图片 ${index + 1} 暂未加载，请查看原文`, PAD + 24, y + 50);
        }
        y += height + 22;
      } finally { if (image) image.src = ""; }
    }
    await flush();
    return { pages, imageCount: attachments.length, failedImages };
  } catch (error) {
    page.canvas.width = page.canvas.height = 0;
    pages.forEach(({ url }) => URL.revokeObjectURL(url));
    throw error;
  }
}

/** Uncompressed ZIP keeps all PNG pages in one browser download, without dependencies. */
export async function packageSharePages(pages: ShareCardPage[]): Promise<Blob> {
  const chunks: BlobPart[] = [];
  const directory: BlobPart[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const [index, page] of pages.entries()) {
    const bytes = new Uint8Array(await page.blob.arrayBuffer());
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const name = new TextEncoder().encode(`card-${String(index + 1).padStart(2, "0")}.png`);
    const local = new ArrayBuffer(30);
    const view = new DataView(local);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true);
    view.setUint32(14, crc, true); view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true); view.setUint16(26, name.length, true);
    chunks.push(local, name, page.blob);
    const central = new ArrayBuffer(46);
    const cv = new DataView(central);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    directory.push(central, name);
    directorySize += 46 + name.length;
    offset += 30 + name.length + bytes.length;
  }
  const end = new ArrayBuffer(22);
  const ev = new DataView(end);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, pages.length, true); ev.setUint16(10, pages.length, true); ev.setUint32(12, directorySize, true); ev.setUint32(16, offset, true);
  return new Blob([...chunks, ...directory, end], { type: "application/zip" });
}
