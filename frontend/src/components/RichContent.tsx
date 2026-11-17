import { useI18n } from "../i18n";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Quote } from "lucide-react";

interface RichContentProps {
  content: string;
  maxCollapsedLength?: number;
}

const URL_REGEX = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
const MENTION_REGEX = /(^|\s)(@[a-zA-Z0-9_]{4,32})/g;
const TAG_REGEX = /(#[\p{L}\p{N}_]+)/gu;

export default function RichContent({
  content,
  maxCollapsedLength = 450,
}: RichContentProps) {
  const { t } = useI18n();
  const isLong = content.length > maxCollapsedLength;
  const [expanded, setExpanded] = useState(false);

  const normalizedContent = useMemo(() => {
    return (
      content
        .replace(/\r\n/g, "\n")
        .split(/\n\s*\n/)
        .map((block) => block.split("\n").filter(Boolean))
        .filter((lines) => lines.length > 0)
        // Telegram text wraps mid-sentence; only join lines that are clearly a
        // continuation (no terminal punctuation) so real paragraph breaks stay.
        .map((lines) =>
          lines.reduce<string[]>((merged, line) => {
            const prev = merged[merged.length - 1];
            if (
              prev &&
              !/[。！？；：…)）]\s*$/.test(prev) &&
              !/^[\d一二三四五六七八九十]+[.、)）]/.test(line)
            ) {
              merged[merged.length - 1] = `${prev}${line}`;
            } else {
              merged.push(line);
            }
            return merged;
          }, []),
        )
        .flat()
        .join("\n\n")
        .trim()
    );
  }, [content]);

  // Paragraph structure: leading headline, quote blocks, trailing signature.
  const paragraphs = useMemo(() => {
    const rawParagraphs = normalizedContent.split("\n\n").filter(Boolean);
    if (!rawParagraphs.length) return [];

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
          para.startsWith('"') ||
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

      return { text: para, isHeader, isQuote, isFooter };
    });
  }, [normalizedContent]);

  const renderFormattedText = (text: string) => {
    const lines = [text];
    return lines.map((line, lineIdx) => {
      const parts = line.split(URL_REGEX);
      return (
        <span key={lineIdx} className="pub-rich-line">
          {parts.map((part, partIdx) => {
            if (part.match(URL_REGEX)) {
              let displayUrl = part;
              try {
                const u = new URL(part);
                displayUrl =
                  u.hostname +
                  (u.pathname !== "/"
                    ? u.pathname.slice(0, 16) +
                      (u.pathname.length > 16 ? "…" : "")
                    : "");
              } catch {
                // keep the raw string
              }
              return (
                <a
                  key={partIdx}
                  href={part}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pub-link-pill"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span>{displayUrl}</span>
                  <ExternalLink size={11} aria-hidden="true" />
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
                    className="pub-mention"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {sub}
                  </a>
                );
              }

              const tagParts = sub.split(TAG_REGEX);
              return tagParts.map((tagPart, tagIdx) =>
                tagPart.startsWith("#") && tagPart.length > 1 ? (
                  <span key={tagIdx} className="pub-tag">
                    {tagPart}
                  </span>
                ) : (
                  tagPart
                ),
              );
            });
          })}
        </span>
      );
    });
  };

  return (
    <div className="pub-rich">
      <div
        className={`pub-rich-fold${!expanded && isLong ? " is-clipped" : ""}`}
      >
        {paragraphs.map((p, idx) => {
          if (p.isHeader) {
            return (
              <h4 key={idx} className="pub-rich-heading">
                <span>{p.text}</span>
              </h4>
            );
          }

          if (p.isQuote) {
            return (
              <div key={idx} className="pub-rich-quote">
                <Quote size={14} aria-hidden="true" />
                <div>{renderFormattedText(p.text)}</div>
              </div>
            );
          }

          if (p.isFooter) {
            return (
              <div key={idx} className="pub-rich-foot">
                {renderFormattedText(p.text)}
              </div>
            );
          }

          return <p key={idx}>{renderFormattedText(p.text)}</p>;
        })}
      </div>

      {isLong && (
        <button
          type="button"
          className="pub-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <span>{t(expanded ? "收起全文" : "展开阅读全文")}</span>
          {expanded ? (
            <ChevronUp size={13} aria-hidden="true" />
          ) : (
            <ChevronDown size={13} aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}
