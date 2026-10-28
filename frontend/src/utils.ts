import type { MediaFilter } from "./types";

export const mediaOptions: Array<{ value: MediaFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "text", label: "纯文本" },
  { value: "photo", label: "图片" },
  { value: "video", label: "视频" },
  { value: "document", label: "文件" },
  { value: "animation", label: "动图" },
  { value: "audio", label: "音频" },
  { value: "voice", label: "语音" },
  { value: "sticker", label: "贴纸" }
];

const compactDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const countFormatter = new Intl.NumberFormat("zh-CN");

export const fullDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

export function mediaLabel(value: string) {
  return mediaOptions.find((item) => item.value === value)?.label || value;
}

export function formatCount(value: number) {
  return countFormatter.format(value);
}

export function cleanMessageContent(content: string) {
  return content.replace(/^\[(photo|video|document|animation|audio|voice|sticker)\]\s*/i, "").trim() || content;
}

export function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return compactDateFormatter.format(date);
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function dayKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatDayLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = startOfDay(new Date());
  const target = startOfDay(date);
  const diff = Math.round((today.getTime() - target.getTime()) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function errorHelp(error: string) {
  return `${error}。请重试；若仍失败，请检查服务状态。`;
}

export function isMediaFilter(value: string): value is MediaFilter {
  return mediaOptions.some((item) => item.value === value);
}

export function sourceHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}
