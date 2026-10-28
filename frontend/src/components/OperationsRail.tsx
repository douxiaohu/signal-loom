import type { AlertMatch, AlertRule, Group, ManagedSource } from "../types";
import AlertPanel from "./operations/AlertPanel";
import SourcePanel from "./operations/SourcePanel";

type OperationsRailProps = {
  alerts: AlertMatch[];
  groups: ManagedSource[];
  rules: AlertRule[];
  /** Keys (see operationKey) of the actions that are running; their controls are disabled. */
  busy?: ReadonlySet<string>;
  focus?: "all" | "sources" | "alerts";
  onAcknowledge: (id: number) => Promise<void>;
  onCreateRule: (name: string, keyword: string) => Promise<void>;
  onCreateSource: (name: string, sourceUrl: string) => Promise<void>;
  onCrawlSource: (chatId: number) => Promise<void>;
  onPatchSource: (group: Group, payload: { enabled?: boolean; public_visible?: boolean }) => Promise<void>;
  onResolve: (id: number) => Promise<void>;
  onToggleRule: (rule: AlertRule) => Promise<void>;
};

/** The admin's source-management and rule-match cards; `focus` picks which of the two a page shows. */
export default function OperationsRail(props: OperationsRailProps) {
  const focus = props.focus || "all";
  const isBusy = (key: string) => props.busy?.has(key) ?? false;
  return (
    <aside className="operations-rail admin-stack" aria-label="来源健康与监测规则">
      {focus !== "alerts" ? (
        <SourcePanel
          groups={props.groups}
          isBusy={isBusy}
          onCreateSource={props.onCreateSource}
          onCrawlSource={props.onCrawlSource}
          onPatchSource={props.onPatchSource}
        />
      ) : null}
      {focus !== "sources" ? (
        <AlertPanel
          alerts={props.alerts}
          rules={props.rules}
          showAll={focus === "alerts"}
          isBusy={isBusy}
          onAcknowledge={props.onAcknowledge}
          onCreateRule={props.onCreateRule}
          onResolve={props.onResolve}
          onToggleRule={props.onToggleRule}
        />
      ) : null}
    </aside>
  );
}
