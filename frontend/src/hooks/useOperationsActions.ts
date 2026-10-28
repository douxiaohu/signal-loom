import { useEffect, useRef, useState } from "react";

import { acknowledgeAlert, crawlSource, createAlertRule, createSource, patchAlertRule, patchSource, resolveAlert } from "../api";
import type { AlertRule, Group } from "../types";
import type { AdminData } from "./useAdminData";

/** Names of the controls that can be busy; the rail uses them to disable what is running. */
export const operationKey = {
  alert: (id: number) => `alert:${id}`,
  rule: (id: number) => `rule:${id}`,
  source: (chatId: number) => `source:${chatId}`,
  crawl: (chatId: number) => `crawl:${chatId}`,
  createRule: "create-rule",
  createSource: "create-source"
} as const;

type Feedback = {
  /** One action per key runs at a time; a repeated click while it runs is ignored. */
  key: string;
  successMessage: string;
  /** Announced while a slow action runs. */
  pendingMessage?: string;
  focusTarget: "alert-operations" | "source-operations";
  reloadSources?: boolean;
  /** The caller (a form) shows the failure itself as well. */
  rethrow?: boolean;
};

type UseOperationsActionsOptions = {
  data: AdminData;
  /** The chat the message filters are on; new rules are limited to it ("all" means every source). */
  scopeChatId: string;
  onUnauthorized: (caught: unknown) => void;
  /** Called when an action starts (the console clears a stale sign-out error). */
  onStart: () => void;
};

/**
 * The write actions of the operations rail. Each one runs, reloads what it
 * changed, announces the result for screen readers and moves focus to the card
 * it belongs to; while it runs its control is reported as busy.
 */
export function useOperationsActions({ data, scopeChatId, onUnauthorized, onStart }: UseOperationsActionsOptions) {
  const [announcement, setAnnouncement] = useState("");
  const [focusRequest, setFocusRequest] = useState<{ targetId: string; sequence: number } | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const running = useRef(new Set<string>());
  const focusSequence = useRef(0);

  useEffect(() => {
    if (!focusRequest) return;
    document.getElementById(focusRequest.targetId)?.focus();
  }, [focusRequest]);

  async function run(action: () => Promise<unknown>, feedback: Feedback): Promise<void> {
    if (running.current.has(feedback.key)) return;
    running.current.add(feedback.key);
    setBusy(new Set(running.current));
    data.clearOperationsError();
    onStart();
    setAnnouncement(feedback.pendingMessage ?? "");
    try {
      await action();
      if (feedback.reloadSources) await data.loadSources();
      await data.loadOperations();
      setAnnouncement(feedback.successMessage);
      setFocusRequest({ targetId: feedback.focusTarget, sequence: ++focusSequence.current });
    } catch (caught) {
      onUnauthorized(caught);
      setAnnouncement("");
      data.reportOperationsError(caught);
      if (feedback.rethrow) throw caught;
    } finally {
      running.current.delete(feedback.key);
      setBusy(new Set(running.current));
    }
  }

  const handlers = {
    onAcknowledge: (id: number) =>
      run(() => acknowledgeAlert(id), { key: operationKey.alert(id), successMessage: "规则命中已确认", focusTarget: "alert-operations" }),
    onResolve: (id: number) =>
      run(() => resolveAlert(id), { key: operationKey.alert(id), successMessage: "规则命中已解决", focusTarget: "alert-operations" }),
    onToggleRule: (rule: AlertRule) =>
      run(() => patchAlertRule(rule.id, { enabled: !rule.enabled }), {
        key: operationKey.rule(rule.id),
        successMessage: rule.enabled ? "规则已停用" : "规则已启用",
        focusTarget: "alert-operations"
      }),
    onCreateRule: (name: string, keyword: string) =>
      run(() => createAlertRule({ name, keyword, source_ids: scopeChatId === "all" ? [] : [Number(scopeChatId)] }), {
        key: operationKey.createRule,
        successMessage: "规则已创建，当前为停用状态",
        focusTarget: "alert-operations",
        rethrow: true
      }),
    onCreateSource: (name: string, sourceUrl: string) =>
      run(() => createSource({ name, source_url: sourceUrl }), {
        key: operationKey.createSource,
        successMessage: "来源已添加，默认仅管理员可见",
        focusTarget: "source-operations",
        reloadSources: true,
        rethrow: true
      }),
    onCrawlSource: (chatId: number) =>
      run(() => crawlSource(chatId), {
        key: operationKey.crawl(chatId),
        successMessage: "已完成一次来源采集",
        pendingMessage: "正在采集来源，最长约需 90 秒",
        focusTarget: "source-operations",
        reloadSources: true
      }),
    onPatchSource: (group: Group, payload: { enabled?: boolean; public_visible?: boolean }) =>
      run(() => patchSource(group.chat_id, payload), {
        key: operationKey.source(group.chat_id),
        successMessage:
          payload.public_visible === true ? "来源已公开"
          : payload.public_visible === false ? "来源已设为私有"
          : payload.enabled === true ? "来源采集已启用"
          : "来源采集已停用",
        focusTarget: "source-operations",
        reloadSources: true
      })
  };

  return { handlers, busy, announcement, clearAnnouncement: () => setAnnouncement("") };
}
