import { vi } from "vitest";

import { groupMessages, type FeedEntry } from "../../src/components/feed/groupMessages";
import type { Message } from "../../src/types";

/** A time on the given local day, so the tests do not depend on the machine's time zone. */
const at = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour, 0).toISOString();

function message(id: number, content: string, time = at(2026, 7, 14)): Message {
  return {
    id,
    chat_id: -1001,
    chat_title: "来源",
    message_id: id,
    sender_name: "编辑",
    message_time: time,
    content,
    media_type: null,
    media_urls: [],
    media_items: [],
    source_url: ""
  };
}

const STORY = "突发：台风将于今晚登陆，相关部门提醒市民做好防范。";

/** "day" for a divider, the id for a message, `id+[similar ids]` for a folded group. */
function shape(entries: FeedEntry[]) {
  return entries.map((entry) =>
    entry.type === "day" ? entry.label : entry.similar.length ? `${entry.message.id}+[${entry.similar.map((item) => item.id).join(",")}]` : String(entry.message.id)
  );
}

describe("groupMessages", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 14, 15, 0));
  });

  it("puts a divider before the first message of each day", () => {
    const entries = groupMessages(
      [message(3, "今天的消息一", at(2026, 7, 14, 13)), message(2, "今天的消息二", at(2026, 7, 14, 9)), message(1, "昨天的消息", at(2026, 7, 13))],
      false
    );

    expect(shape(entries)).toEqual(["今天", "3", "2", "昨天", "1"]);
    expect(entries.filter((entry) => entry.type === "day").map((entry) => (entry as { key: string }).key)).toHaveLength(2);
  });

  it("does not group anything unless asked to", () => {
    const entries = groupMessages([message(2, STORY), message(1, STORY)], false);

    expect(shape(entries)).toEqual(["今天", "2", "1"]);
  });

  it("folds repeats of a story into its first appearance, in order", () => {
    const entries = groupMessages([message(4, STORY), message(3, "另一条完全不同的消息内容"), message(2, STORY), message(1, STORY)], true);

    expect(shape(entries)).toEqual(["今天", "4+[2,1]", "3"]);
  });

  it("ignores the media tag Telegram puts in front of a caption when comparing", () => {
    const entries = groupMessages([message(2, `[photo] ${STORY}`), message(1, STORY)], true);

    expect(shape(entries)).toEqual(["今天", "2+[1]"]);
  });

  it("does not fold short texts, however often they repeat", () => {
    const entries = groupMessages([message(3, "天气"), message(2, "天气"), message(1, "")], true);

    expect(shape(entries)).toEqual(["今天", "3", "2", "1"]);
  });

  it("does not fold messages whose text only starts alike", () => {
    const entries = groupMessages([message(2, `${STORY}更新`), message(1, STORY)], true);

    expect(shape(entries)).toEqual(["今天", "2", "1"]);
  });

  it("folds a repeat into an earlier message of another day without leaving a lone divider behind", () => {
    const entries = groupMessages([message(2, STORY, at(2026, 7, 14)), message(1, STORY, at(2026, 7, 13))], true);

    expect(shape(entries)).toEqual(["今天", "2+[1]"]);
  });

  it("still shows the divider of a day once one of its messages is shown", () => {
    const entries = groupMessages(
      [message(3, STORY, at(2026, 7, 14)), message(2, STORY, at(2026, 7, 13, 18)), message(1, "只出现在昨天的消息", at(2026, 7, 13, 9))],
      true
    );

    expect(shape(entries)).toEqual(["今天", "3+[2]", "昨天", "1"]);
  });

  it("copes with a long feed of one repeated story", () => {
    const many = Array.from({ length: 3000 }, (_, index) => message(3000 - index, STORY));

    const entries = groupMessages(many, true);

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ type: "message", message: { id: 3000 } });
    expect((entries[1] as Extract<FeedEntry, { type: "message" }>).similar).toHaveLength(2999);
  });

  it("returns nothing for an empty feed", () => {
    expect(groupMessages([], true)).toEqual([]);
  });
});
