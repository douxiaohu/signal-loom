import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import OperationsRail from "../src/components/OperationsRail";

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
});
