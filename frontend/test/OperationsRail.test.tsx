import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import OperationsRail from "../src/components/OperationsRail";
import { operationKey } from "../src/hooks/useOperationsActions";
import type { AlertMatch, AlertRule, ManagedSource } from "../src/types";

function managedSource(chatId: number, name: string, extra: Partial<ManagedSource> = {}): ManagedSource {
  return {
    chat_id: chatId,
    name,
    source: null,
    source_type: "public",
    enabled: true,
    public_visible: true,
    message_count: 1,
    last_message_time: null,
    health_status: "healthy",
    last_run_at: null,
    last_success_at: null,
    last_error: null,
    fetched_count: 4,
    saved_count: 2,
    ...extra
  };
}

const noop = async () => undefined;

function renderRail(props: Partial<React.ComponentProps<typeof OperationsRail>> = {}) {
  return render(
    <OperationsRail
      alerts={[]}
      groups={[]}
      rules={[]}
      onAcknowledge={noop}
      onCreateRule={noop}
      onCreateSource={noop}
      onCrawlSource={noop}
      onPatchSource={noop}
      onResolve={noop}
      onToggleRule={noop}
      {...props}
    />
  );
}

const failing = managedSource(-1, "反复失败的来源", { consecutive_failures: 3, new_message_volume: 0, health_status: "error", last_error: "超时" });
const fine = managedSource(-2, "一切正常的来源", { consecutive_failures: 0, new_message_volume: 7 });
const unknown = managedSource(-3, "统计未加载的来源");

describe("OperationsRail", () => {
  it("keeps rule input and shows an inline error when creation fails", async () => {
    const onCreateRule = vi.fn().mockRejectedValue(new Error("规则保存失败"));
    render(
      <OperationsRail
        alerts={[]}
        groups={[]}
        rules={[]}
        onAcknowledge={async () => undefined}
        onCreateRule={onCreateRule}
        onCreateSource={async () => undefined}
        onCrawlSource={async () => undefined}
        onPatchSource={async () => undefined}
        onResolve={async () => undefined}
        onToggleRule={async () => undefined}
      />
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("管理监测规则"));
    await user.type(screen.getByLabelText("规则名称"), "高危漏洞");
    await user.type(screen.getByLabelText("普通关键词"), "漏洞");
    await user.click(screen.getByRole("button", { name: "创建为停用规则" }));

    expect(await screen.findByText("规则保存失败")).toBeInTheDocument();
    expect(screen.getByLabelText("规则名称")).toHaveValue("高危漏洞");
    expect(screen.getByLabelText("普通关键词")).toHaveValue("漏洞");
  });

  it("lists every source, with its counters once the operations summary has loaded", () => {
    renderRail({ groups: [failing, fine, unknown] });

    expect(screen.getByText("反复失败的来源")).toBeInTheDocument();
    expect(screen.getByText(/连续失败 3 · 新增 0/)).toBeInTheDocument();
    expect(screen.getByText(/连续失败 0 · 新增 7/)).toBeInTheDocument();
    // Nothing is known about this one yet, so no counter is made up for it.
    const row = screen.getByText("统计未加载的来源").closest("td") as HTMLElement;
    expect(row).not.toHaveTextContent("连续失败");
    expect(row).not.toHaveTextContent("新增");
  });

  it("filters sources by consecutive failures", async () => {
    renderRail({ groups: [failing, fine, unknown] });
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("来源异常筛选"), "failures");

    expect(screen.getByText("反复失败的来源")).toBeInTheDocument();
    expect(screen.queryByText("一切正常的来源")).not.toBeInTheDocument();
    expect(screen.queryByText("统计未加载的来源")).not.toBeInTheDocument();
  });

  it("filters sources whose latest run saved nothing", async () => {
    renderRail({ groups: [failing, fine, unknown] });
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("来源异常筛选"), "volume");

    expect(screen.getByText("反复失败的来源")).toBeInTheDocument();
    expect(screen.queryByText("一切正常的来源")).not.toBeInTheDocument();
    expect(screen.queryByText("统计未加载的来源")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("来源异常筛选"), "all");
    expect(screen.getByText("统计未加载的来源")).toBeInTheDocument();
  });

  it("disables the controls of an action that is running and shows that a crawl is in progress", () => {
    renderRail({ groups: [fine, failing], busy: new Set([operationKey.crawl(-2), operationKey.source(-1)]) });

    const crawling = screen.getByRole("button", { name: "采集中…" });
    expect(crawling).toBeDisabled();
    expect(crawling).toHaveAttribute("aria-busy", "true");

    const [fineRow, failingRow] = screen.getAllByRole("row").slice(1);
    // Source -2 only has its crawl running; source -1 is being patched.
    expect(within(fineRow).getByRole("button", { name: "私有" })).toBeEnabled();
    expect(within(failingRow).getByRole("button", { name: "私有" })).toBeDisabled();
    expect(within(failingRow).getByRole("button", { name: "停用" })).toBeDisabled();
    expect(within(failingRow).getByRole("button", { name: "采集" })).toBeEnabled();
  });

  it("disables an alert's and a rule's buttons while their action runs", async () => {
    const alert: AlertMatch = {
      id: 7, rule_id: 3, rule_name: "高危漏洞", keyword: "漏洞", status: "new", matched_at: "2026-07-13T08:02:00+00:00",
      chat_title: "来源", sender_name: "值班员", message_time: "2026-07-13T08:01:00+00:00", content: "高危漏洞通报", media_type: null
    };
    const rule: AlertRule = {
      id: 3, name: "高危漏洞", keyword: "漏洞", media_type: null, quiet_start: null, quiet_end: null, cooldown_minutes: 10,
      enabled: true, source_ids: [], created_at: "2026-07-13T08:00:00+00:00", updated_at: "2026-07-13T08:00:00+00:00"
    };
    renderRail({ alerts: [alert], rules: [rule], busy: new Set([operationKey.alert(7), operationKey.rule(3)]) });
    const user = userEvent.setup();
    await user.click(screen.getByText("管理监测规则"));

    expect(screen.getByRole("button", { name: "确认" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "解决" })).toBeDisabled();
    const ruleList = document.querySelector(".rule-list") as HTMLElement;
    expect(within(ruleList).getByRole("button", { name: "停用" })).toBeDisabled();
  });

  it("calls the handlers when nothing is busy", async () => {
    const onCrawlSource = vi.fn(noop);
    const onPatchSource = vi.fn(noop);
    renderRail({ groups: [fine], onCrawlSource, onPatchSource });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "采集" }));
    await user.click(screen.getByRole("button", { name: "私有" }));

    expect(onCrawlSource).toHaveBeenCalledWith(-2);
    expect(onPatchSource).toHaveBeenCalledWith(fine, { public_visible: false });
  });
});
