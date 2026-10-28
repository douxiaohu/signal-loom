import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import SourceComposer from "../../src/components/operations/SourceComposer";
import { deferred } from "../hooks/helpers";

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("添加公开 Telegram 频道"));
  await user.type(screen.getByLabelText("来源名称"), "竹新社");
  await user.type(screen.getByLabelText("频道链接"), "https://t.me/tnews365");
}

describe("SourceComposer", () => {
  it("submits the typed source and clears the form once it was added", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<SourceComposer onCreate={onCreate} />);
    const user = userEvent.setup();
    await fill(user);

    await user.click(screen.getByRole("button", { name: "添加来源（默认不公开）" }));

    expect(onCreate).toHaveBeenCalledWith("竹新社", "https://t.me/tnews365");
    expect(screen.getByLabelText("来源名称")).toHaveValue("");
    expect(screen.getByLabelText("频道链接")).toHaveValue("");
  });

  it("keeps what was typed and shows why adding failed", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("该来源已存在"));
    render(<SourceComposer onCreate={onCreate} />);
    const user = userEvent.setup();
    await fill(user);

    await user.click(screen.getByRole("button", { name: "添加来源（默认不公开）" }));

    expect(await screen.findByText("该来源已存在")).toBeInTheDocument();
    expect(screen.getByLabelText("来源名称")).toHaveValue("竹新社");
    expect(screen.getByLabelText("频道链接")).toHaveValue("https://t.me/tnews365");
  });

  it("falls back to a generic message for a failure without one", async () => {
    render(<SourceComposer onCreate={vi.fn().mockRejectedValue("boom")} />);
    const user = userEvent.setup();
    await fill(user);

    await user.click(screen.getByRole("button", { name: "添加来源（默认不公开）" }));

    expect(await screen.findByText("来源创建失败，请重试。")).toBeInTheDocument();
  });

  it("disables the button while the source is being added and clears an old error on the next try", async () => {
    const pending = deferred<void>();
    const onCreate = vi.fn().mockRejectedValueOnce(new Error("第一次失败")).mockImplementationOnce(() => pending.promise);
    render(<SourceComposer onCreate={onCreate} />);
    const user = userEvent.setup();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "添加来源（默认不公开）" }));
    expect(await screen.findByText("第一次失败")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "添加来源（默认不公开）" }));

    expect(screen.getByRole("button", { name: "正在添加…" })).toBeDisabled();
    expect(screen.queryByText("第一次失败")).not.toBeInTheDocument();
    pending.resolve();
    expect(await screen.findByRole("button", { name: "添加来源（默认不公开）" })).toBeEnabled();
  });
});
