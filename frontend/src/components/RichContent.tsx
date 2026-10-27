import { useState, useMemo } from "react";
import { ExternalLink, ChevronDown, ChevronUp, Copy, Check } from "lucide-react";

interface RichContentProps {
  content: string;
  maxCollapsedLength?: number;
}

// URL 正则表达式
const URL_REGEX = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
// @username 正则
const MENTION_REGEX = /(^|\s)(@[a-zA-Z0-9_]{4,32})/g;

export default function RichContent({ content, maxCollapsedLength = 360 }: RichContentProps) {
  const isLong = content.length > maxCollapsedLength;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const displayText = useMemo(() => {
    if (!isLong || expanded) return content;
    return content.slice(0, maxCollapsedLength) + "…";
  }, [content, isLong, expanded, maxCollapsedLength]);

  // 解析并高亮文本中的链接与 @提及
  const parsedNodes = useMemo(() => {
    const lines = displayText.split("\n");
    return lines.map((line, lineIndex) => {
      // 拆分 URL
      const parts = line.split(URL_REGEX);
      return (
        <span key={lineIndex} className="block min-h-[1.4em]">
          {parts.map((part, partIndex) => {
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
                  key={partIndex}
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

            // 拆分 @mention
            const subParts = part.split(MENTION_REGEX);
            return subParts.map((sub, subIndex) => {
              if (sub.startsWith("@")) {
                const username = sub.slice(1);
                return (
                  <a
                    key={subIndex}
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
  }, [displayText]);

  return (
    <div className="relative group/content text-[14.5px] leading-relaxed text-[var(--foreground)]">
      <div className={`overflow-hidden transition-all duration-300 ${!expanded && isLong ? "relative" : ""}`}>
        {parsedNodes}

        {!expanded && isLong && (
          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-[var(--card)] to-transparent pointer-events-none" />
        )}
      </div>

      <div className="flex items-center justify-between mt-2 pt-1 border-t border-[var(--border)]/40">
        {isLong ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1 text-xs font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors py-0.5 px-2 rounded-md hover:bg-[var(--surface-muted)] cursor-pointer"
          >
            {expanded ? (
              <>
                <span>收起全文</span>
                <ChevronUp size={14} />
              </>
            ) : (
              <>
                <span>展开全文</span>
                <ChevronDown size={14} />
              </>
            )}
          </button>
        ) : <div />}

        <button
          type="button"
          onClick={handleCopy}
          aria-label="复制正文"
          title="复制正文内容"
          className="inline-flex items-center gap-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] opacity-60 group-hover/content:opacity-100 transition-all duration-200 py-1 px-2 rounded-md hover:bg-[var(--surface-muted)] cursor-pointer"
        >
          {copied ? (
            <>
              <Check size={13} className="text-emerald-500" />
              <span className="text-emerald-500 font-medium">已复制</span>
            </>
          ) : (
            <>
              <Copy size={13} />
              <span>复制</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
