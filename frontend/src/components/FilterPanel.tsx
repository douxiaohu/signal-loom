import { FormEvent, useEffect, useRef } from "react";
import { Search, X } from "lucide-react";

import type { Filters, Group, MediaFilter } from "../types";
import { formatCount, mediaOptions } from "../utils";

type FilterPanelProps = {
  draft: Filters;
  groups: Group[];
  open: boolean;
  onChange: (filters: Filters) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export default function FilterPanel({ draft, groups, open, onChange, onClose, onSubmit }: FilterPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open || !window.matchMedia("(max-width: 1180px)").matches) return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
    ));
    panel.querySelector<HTMLInputElement>('input[name="chat_id"]')?.focus();
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== "Tab" || !focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    panel.addEventListener("keydown", trapFocus);
    return () => panel.removeEventListener("keydown", trapFocus);
  }, [open]);
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <aside
      ref={panelRef}
      className={`filter-panel ${open ? "is-open" : ""}`}
      aria-label="来源与筛选"
      aria-modal={open ? true : undefined}
      role={open ? "dialog" : undefined}
    >
      <div className="panel-heading">
        <div><p className="section-kicker">筛选</p><h2>来源与筛选</h2></div>
        <button className="icon-button close-drawer" type="button" onClick={onClose} aria-label="关闭筛选"><X size={20} aria-hidden="true" /></button>
      </div>
      <form aria-label="消息筛选" onSubmit={submit}>
        <fieldset className="source-list">
          <legend>监测来源</legend>
          <label className={`source-option ${draft.chatId === "all" ? "selected" : ""}`}>
            <input type="radio" name="chat_id" value="all" checked={draft.chatId === "all"} onChange={() => onChange({ ...draft, chatId: "all" })} />
            <span className="health-dot health-all" aria-hidden="true" /><span><strong>全部来源</strong><small>{groups.length} 个监测源</small></span>
          </label>
          {groups.map((group) => (
            <label className={`source-option ${draft.chatId === String(group.chat_id) ? "selected" : ""}`} key={group.chat_id}>
              <input type="radio" name="chat_id" value={group.chat_id} checked={draft.chatId === String(group.chat_id)} onChange={() => onChange({ ...draft, chatId: String(group.chat_id) })} />
              <span className={`health-dot health-${group.health_status}`} aria-hidden="true" />
              <span><strong>{group.name}</strong><small>{formatCount(group.message_count)} 条 · {healthText(group.health_status)}</small></span>
            </label>
          ))}
        </fieldset>
        <label className="field-label" htmlFor="media-filter">媒体类型</label>
        <select id="media-filter" name="media" value={draft.media} onChange={(event) => onChange({ ...draft, media: event.target.value as MediaFilter })}>
          {mediaOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <label className="field-label" htmlFor="query-filter">关键词</label>
        <div className="search-input">
          <Search size={17} aria-hidden="true" />
          <input id="query-filter" name="query" type="search" value={draft.query} onChange={(event) => onChange({ ...draft, query: event.target.value })} placeholder="例如：高危漏洞…" autoComplete="off" />
        </div>
        <button className="primary-button filter-submit" type="submit">应用筛选</button>
      </form>
    </aside>
  );
}

function healthText(status: Group["health_status"]) {
  return { healthy: "正常", stale: "延迟", error: "异常", unknown: "未运行" }[status];
}
