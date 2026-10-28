import { useState } from "react";

import { useAsyncSubmit } from "../../hooks/useAsyncSubmit";
import { operationKey } from "../../hooks/useOperationsActions";
import type { AlertRule } from "../../types";

type RuleComposerProps = {
  rules: AlertRule[];
  isBusy: (key: string) => boolean;
  onCreate: (name: string, keyword: string) => Promise<void>;
  onToggle: (rule: AlertRule) => Promise<void>;
};

export default function RuleComposer({ rules, isBusy, onCreate, onToggle }: RuleComposerProps) {
  const [name, setName] = useState("");
  const [keyword, setKeyword] = useState("");
  const { busy, error, submit } = useAsyncSubmit("规则创建失败，请重试。");
  return (
    <details className="rule-composer">
      <summary>管理监测规则</summary>
      <div className="rule-list">
        {rules.map((rule) => <div key={rule.id}><span><strong>{rule.name}</strong><small>关键词：{rule.keyword}</small></span><button type="button" disabled={isBusy(operationKey.rule(rule.id))} onClick={() => void onToggle(rule)}>{rule.enabled ? "停用" : "启用"}</button></div>)}
      </div>
      <form
        onSubmit={(event) =>
          submit(event, async () => {
            await onCreate(name, keyword);
            setName("");
            setKeyword("");
          })
        }
      >
        <label htmlFor="rule-name">规则名称</label><input id="rule-name" name="name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoComplete="off" />
        <label htmlFor="rule-keyword">普通关键词</label><input id="rule-keyword" name="keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} required maxLength={200} autoComplete="off" />
        {error ? <p className="form-error">{error}</p> : null}
        <button type="submit" disabled={busy}>{busy ? "正在创建…" : "创建为停用规则"}</button>
      </form>
    </details>
  );
}
