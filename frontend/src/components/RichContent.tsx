import { useState, useMemo } from "react";
import { ExternalLink, ChevronDown, ChevronUp } from "lucide-react";

interface RichContentProps {
  content: string;
  maxCollapsedLength?: number;
}

const URL_REGEX = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
const MENTION_REGEX = /(^|\s)(@[a-zA-Z0-9_]{4,32})/g;

export default function RichContent({ content, maxCollapsedLength = 400 }: RichContentProps) {
  const isLong = content.length > maxCollapsedLength;
  const [expanded, setExpanded] = useState(false);

  // 规范化正文：收敛连续多个多余空行
  const normalizedContent = useMemo(() => {
    return content.trim().replace(/\n{3,}/g, "\n\n");
  }, [content]);

  // 智能解析段落结构（首行大标题 + 正文段落 + 尾注签名）
  const paragraphs = useMemo(() => {
    const rawParagraphs = normalizedContent.split("\n\n").filter(Boolean);
    if (!rawParagraphs.length) return [];

    // 判断第一段是否适合作为大标题展示（长度在 8~90 字符之间，且后续还有其他段落）
    const firstPara = rawParagraphs[0].trim();
    const hasHeader =
      rawParagraphs.length > 1 &&
      firstPara.length >= 8 &&
      firstPara.length <= 90 &&
      !firstPara.startsWith("http") &&
      !firstPara.includes("\n");

    return rawParagraphs.map((para, idx) => {
      const isHeader = hasHeader && idx === 0;
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
        isFooter,
      };
    });
  }, [normalizedContent]);

  // 处理文本中的高亮与链接
  const renderFormattedText = (text: string) => {
    const lines = text.split("\n");
    return lines.map((line, lineIdx) => {
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
                  className="inline-flex items-center gap-0.5 text-blue-600 dark:text-blue-400 hover:underline break-all transition-colors duration-150 mx-0.5 font-medium"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span>{displayUrl}</span>
                  <ExternalLink size={12} className="inline opacity-70 shrink-0" />
                </a>
              );
            }

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
                    className="text-cyan-600 dark:text-cyan-400 font-medium hover:underline transition-colors duration-150"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {sub}
                  </a>
                );
              }
              return sub;
            });
          })}
        </span>
      );
    });
  };

  return (
    <div className="relative text-[15px] text-[var(--foreground)] font-normal tracking-normal select-text">
      {/* 限制折叠高度 */}
      <div
        className={`transition-all duration-300 ${
          !expanded && isLong ? "max-h-[220px] overflow-hidden relative" : ""
        }`}
      >
        <div className="space-y-2.5">
          {paragraphs.map((p, idx) => {
            if (p.isHeader) {
              return (
                <h4
                  key={idx}
                  className="text-[16px] sm:text-[17px] font-semibold text-[var(--foreground)] leading-snug tracking-tight pb-0.5"
                >
                  {p.text}
                </h4>
              );
            }

            if (p.isFooter) {
              return (
                <div
                  key={idx}
                  className="pt-2 mt-2 border-t border-[var(--border)]/40 text-[12.5px] text-[var(--muted-foreground)] opacity-85"
                >
                  {renderFormattedText(p.text)}
                </div>
              );
            }

            return (
              <p key={idx} className="text-[14.5px] sm:text-[15px] leading-relaxed text-[var(--foreground)]/90">
                {renderFormattedText(p.text)}
              </p>
            );
          })}
        </div>

        {/* 长文折叠平滑渐变蒙层 */}
        {!expanded && isLong && (
          <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-[var(--card)] via-[var(--card)]/80 to-transparent pointer-events-none" />
        )}
      </div>

      {/* 展开/收起按钮 */}
      {isLong && (
        <div className="flex justify-center mt-3 pt-1">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1 text-xs font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] bg-[var(--surface-muted)] hover:bg-[var(--accent)] border border-[var(--border)] rounded-full transition-all duration-150 cursor-pointer shadow-2xs"
          >
            {expanded ? (
              <>
                <span>收起全文</span>
                <ChevronUp size={13} />
              </>
            ) : (
              <>
                <span>展开全文</span>
                <ChevronDown size={13} />
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
