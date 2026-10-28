import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";

import { useNewMessageWatcher } from "../../src/hooks/useNewMessageWatcher";
import type { Filters, Message, MessagePage } from "../../src/types";
import { deferred, message, page } from "./helpers";

const ALL: Filters = { chatId: "all", media: "all", query: "" };
const SOURCE_42: Filters = { chatId: "42", media: "all", query: "" };

type Props = { filters: Filters; messages: Message[]; generation: number; enabled: boolean };

function setup(
  fetchPage: (filters: Filters) => Promise<MessagePage>,
  initial: Partial<Props> = {},
  extra: { onError?: (caught: unknown) => void; formatError?: (caught: unknown) => string; intervalMs?: number } = {}
) {
  const props: Props = { filters: ALL, messages: [message(1)], generation: 1, enabled: true, ...initial };
  return renderHook((current: Props) => useNewMessageWatcher({ ...current, fetchPage, ...extra }), { initialProps: props });
}

/** Lets the polling interval fire and the async check it starts settle. */
async function tick(ms = 60_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

const ids = (result: { current: { pending: Message[] } }) => result.current.pending.map((item) => item.id);

describe("useNewMessageWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("holds back messages that are not on screen yet", async () => {
    const fetchPage = vi.fn(async () => page([3, 2, 1]));
    const { result } = setup(fetchPage);
    expect(result.current.pending).toEqual([]);

    await tick();

    expect(ids(result)).toEqual([3, 2]); // 1 is already visible
    expect(fetchPage).toHaveBeenCalledWith(ALL);
  });

  it("checks once a minute by default and honours a custom interval", async () => {
    const fetchPage = vi.fn(async () => page([1]));
    setup(fetchPage);
    await tick(59_000);
    expect(fetchPage).not.toHaveBeenCalled();
    await tick(1_000);
    expect(fetchPage).toHaveBeenCalledTimes(1);

    const custom = vi.fn(async () => page([1]));
    setup(custom, {}, { intervalMs: 5_000 });
    await tick(5_000);
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it("accumulates across checks without duplicates", async () => {
    const answers = [page([2, 1]), page([3, 2, 1])];
    const fetchPage = vi.fn(async () => answers.shift() ?? page([1]));
    const { result } = setup(fetchPage);

    await tick();
    expect(ids(result)).toEqual([2]);
    await tick();
    expect(ids(result)).toEqual([3, 2]);
  });

  it("ignores an answer for filters that are no longer shown", async () => {
    const slow = deferred<MessagePage>();
    const fetchPage = vi.fn(() => slow.promise);
    const { result, rerender } = setup(fetchPage);

    await tick();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    rerender({ filters: SOURCE_42, messages: [message(100)], generation: 2, enabled: true });
    slow.resolve(page([9, 8]));
    await tick(0);

    expect(result.current.pending).toEqual([]);
  });

  it("forgets what was waiting when the list is reloaded", async () => {
    const { result, rerender } = setup(async () => page([2, 1]));
    await tick();
    expect(ids(result)).toEqual([2]);

    rerender({ filters: ALL, messages: [message(2), message(1)], generation: 2, enabled: true });
    expect(result.current.pending).toEqual([]);
  });

  it("clear() drops the waiting messages", async () => {
    const { result } = setup(async () => page([2, 1]));
    await tick();
    expect(ids(result)).toEqual([2]);

    act(() => result.current.clear());
    expect(result.current.pending).toEqual([]);
  });

  it("reports a failed check, passes it to onError and recovers on the next success", async () => {
    const onError = vi.fn();
    let fail = true;
    const fetchPage = vi.fn(async () => {
      if (fail) throw new Error("503");
      return page([2, 1]);
    });
    const { result } = setup(fetchPage, {}, { onError, formatError: (caught) => `检查失败：${(caught as Error).message}` });

    await tick();
    expect(result.current.error).toBe("检查失败：503");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toEqual([]);

    fail = false;
    await tick();
    expect(result.current.error).toBe("");
    expect(ids(result)).toEqual([2]);
  });

  it("does not poll while disabled", async () => {
    const fetchPage = vi.fn(async () => page([2, 1]));
    const { result, rerender } = setup(fetchPage, { enabled: false });

    await tick(180_000);
    expect(fetchPage).not.toHaveBeenCalled();

    rerender({ filters: ALL, messages: [message(1)], generation: 1, enabled: true });
    await tick();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(ids(result)).toEqual([2]);
  });

  it("compares against the messages on screen at the time the answer arrives", async () => {
    const slow = deferred<MessagePage>();
    const fetchPage = vi.fn(() => slow.promise);
    const { result, rerender } = setup(fetchPage);

    await tick();
    rerender({ filters: ALL, messages: [message(2), message(1)], generation: 1, enabled: true }); // user revealed #2 meanwhile
    slow.resolve(page([2, 1]));
    await tick(0);

    expect(result.current.pending).toEqual([]);
  });
});
