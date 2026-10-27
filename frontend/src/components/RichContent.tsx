import { useState, useMemo } from "react";
import { ExternalLink, ChevronDown, ChevronUp, Quote } from "lucide-react";

interface RichContentProps {
  content: string;
  maxCollapsedLength?: number;
}

const URL_REGEX = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
const MENTION_REGEX = /(^|\s)(@[a-zA-Z0-9_]{4,32})/g;
const TAG_REGEX = /(#[\p{L}\p{N}_]+)/gu;

export default function RichContent({ content, maxCollapsedLength = 450 }: RichContentProps) {
  const isLong = content.length > maxCollapsedLength;
  const [expanded, setExpanded] = useState(false);

  // 规范化正文：收敛连续多个多余空行
  const normalizedContent = useMemo(() => {
    return content.trim().replace(/\n{3,}/g, "\n\n");
  }, [content]);

  // 智能解析段落结构（首行大标题 + 正文段落 + 尾注签名 + 引用块）
  const paragraphs = useMemo(() => {
    const rawParagraphs = normalizedContent.split("\n\n").filter(Boolean);
    if (!rawParagraphs.length) return [];

    // 判断第一段是否适合作为大标题展示（长度在 6~95 字符之间，且后续还有其他段落）
    const firstPara = rawParagraphs[0].trim();
    const hasHeader =
      rawParagraphs.length > 1 &&
      firstPara.length >= 6 &&
      firstPara.length <= 95 &&
      !firstPara.startsWith("http") &&
      !firstPara.includes("\n");

    return rawParagraphs.map((para, idx) => {
      const isHeader = hasHeader && idx === 0;
      const isQuote =
        !isHeader &&
        (para.startsWith("“") ||
          para.startsWith("\"") ||
          para.startsWith("【") ||
          para.includes("转发自") ||
          para.includes("据介绍") ||
          para.includes("援引"));
      const isFooter =
        idx === rawParagraphs.length - 1 &&
        (para.startsWith("🌸") ||
          para.startsWith("📌") ||
          para.startsWith("🏷️") ||
          para.startsWith("#") ||
          para.includes("投稿") ||
          para.includes("茶馆") ||
          para.includes("声明"));

      return {
        text: para,
        isHeader,
        isQuote,
        isFooter,
      };
    });
  }, [normalizedContent]);

  // 处理文本中的高亮、链接、Tag药丸与@Mention
  const renderFormattedText = (text: string) => {
    const lines = text.split("\n");
    return lines.map((line, lineIdx) => {
      // 拆分 URL
      const parts = line.split(URL_REGEX);
      return (
        <span key={lineIdx} className="block leading-relaxed">
          {parts.map((part, partIdx) => {
            if (part.match(URL_REGEX)) {
              let displayUrl = part;
              try {
                const u = new URL(part);
                displayUrl = u.hostname + (u.pathname !== "/" ? u.pathname.slice(0, 16) + (u.pathname.length > 16 ? "…" : "") : "");
              } catch {
                // fallback
              }
              return (
                <a
                  key={partIdx}
                  href={part}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[var(--neon)] hover:underline break-all transition-all duration-150 mx-1 font-mono text-[13px] bg-[var(--neon)]/10 px-2 py-0.5 rounded-md border border-[var(--neon)]/20 hover:shadow-[0_0_8px_rgba(0,240,255,0.3)]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span>{displayUrl}</span>
                  <ExternalLink size={11} className="inline opacity-80 shrink-0" />
                </a>
              );
            }

            // 处理 Mention (@...)
            const subParts = part.split(MENTION_REGEX);
            return subParts.map((sub, subIdx) => {
              if (sub.startsWith("@")) {
                const username = sub.slice(1);
                return (
                  <a
                    key={subIdx}
                    href={`https://t.me/${username}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center text-cyan-400 font-medium hover:underline transition-colors duration-150 px-1 py-0.2 rounded bg-cyan-500/10 border border-cyan-500/20 text-[13px]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {sub}
                  </a>
                );
              }

              // 处理 Tag (#标签)
              const tagParts = sub.split(TAG_REGEX);
              return tagParts.map((tagPart, tagIdx) => {
                if (tagPart.startsWith("#") && tagPart.length > 1) {
                  return (
                    <span
                      key={tagIdx}
                      className="inline-flex items-center mx-1 px-2 py-0.5 rounded-full text-xs font-mono font-medium bg-purple-500/10 text-purple-300 border border-purple-500/30 shadow-[0_0_8px_rgba(168,85,247,0.15)]"
                    >
                      {tagPart}
                    </span>
                  );
                }
                return tagPart;
              });
            });
          })}
        </span>
      );
    });
  };

  return (
    <div className="relative text-[14.5px] sm:text-[15px] text-[var(--foreground)] font-normal tracking-normal select-text space-y-3">
      {/* 限制折叠高度 */}
      <div
        className={`transition-all duration-300 ${
          !expanded && isLong ? "max-h-[240px] overflow-hidden relative" : ""
        }`}
      >
        <div className="space-y-3">
          {paragraphs.map((p, idx) => {
            // 首行加粗大标题 (Bold crisp title with high contrast)
            if (p.isHeader) {
              return (
                <h4
                  key={idx}
                  className="text-[17px] sm:text-[18.5px] font-bold text-white dark:text-white tracking-tight leading-snug pb-1 border-b border-[var(--border)]/40 flex items-center gap-2"
                >
                  <span className="w-1.5 h-4 rounded-full bg-[var(--neon)] shadow-[0_0_8px_var(--neon)] inline-block shrink-0" />
                  <span>{p.text}</span>
                </h4>
              );
            }

            // 引用块 (Stylized Quote Card with blur and subtle gradient)
            if (p.isQuote) {
              return (
                <div
                  key={idx}
                  className="relative p-3.5 sm:p-4 rounded-xl bg-gradient-to-r from-[var(--surface-muted)]/80 to-[var(--card)]/40 border-l-2 border-l-[var(--neon)] border border-[var(--border)] backdrop-blur-md shadow-inner text-[14px] text-[var(--foreground)]/95"
                >
                  <Quote size={14} className="text-[var(--neon)] mb-1 opacity-70" />
                  <div>{renderFormattedText(p.text)}</div>
                </div>
              );
            }

            // 尾注说明段落
            if (p.isFooter) {
              return (
                <div
                  key={idx}
                  className="pt-2.5 mt-2 border-t border-[var(--border)]/40 text-[12.5px] text-[var(--muted-foreground)] opacity-85 flex flex-wrap items-center gap-1.5"
                >
                  {renderFormattedText(p.text)}
                </div>
              );
            }

            // 普通正文段落
            return (
              <p key={idx} className="leading-relaxed text-[var(--foreground)]/90 font-normal">
                {renderFormattedText(p.text)}
              </p>
            );
          })}
        </div>

        {/* 长文折叠平滑渐变蒙层 */}
        {!expanded && isLong && (
          <div className="absolute bottom-0 left-0 right-0 h-28 bg-gradient-to-t from-[var(--card)] via-[var(--card)]/90 to-transparent pointer-events-none" />
        )}
      </div>

      {/* 展开/收起按钮 */}
      {isLong && (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-[var(--muted-foreground)] hover:text-[var(--neon)] bg-[var(--surface-muted)] hover:bg-[var(--card)] border border-[var(--border)] hover:border-[var(--neon)]/50 rounded-full transition-all duration-200 cursor-pointer shadow-sm hover:shadow-[0_0_12px_rgba(0,240,255,0.2)]"
          >
            {expanded ? (
              <>
                <span>收起全文</span>
                <ChevronUp size={13} />
              </>
            ) : (
              <>
                <span>展开阅读全文</span>
                <ChevronDown size={13} />
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
