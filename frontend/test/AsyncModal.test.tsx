import { lazy, useRef, useState, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AsyncModal from "../src/components/AsyncModal";

function Harness({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <p>Reading stays visible</p>
      <button ref={trigger} onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <AsyncModal
          label="Preview"
          onClose={() => setOpen(false)}
          returnFocusRef={trigger}
        >
          {children}
        </AsyncModal>
      )}
    </>
  );
}

describe("optional dialog loading", () => {
  it("remains dismissible with Escape and returns focus while code is pending", async () => {
    const Pending = lazy(
      () => new Promise<{ default: () => ReactNode }>(() => {}),
    );
    const user = userEvent.setup();
    render(
      <Harness>
        <Pending />
      </Harness>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(
      await screen.findByRole("dialog", { name: "Preview" }),
    ).toBeVisible();
    expect(document.body).toHaveClass("viewer-open");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body).not.toHaveClass("viewer-open");
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
  });

  it("contains a failed code load without replacing the reading content", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Failed = lazy(() =>
      Promise.reject(new Error("Optional chunk unavailable")),
    );
    const user = userEvent.setup();
    render(
      <Harness>
        <Failed />
      </Harness>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法打开，请刷新页面后重试。",
    );
    expect(screen.getByText("Reading stays visible")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
  });
});
