import type { Message } from "../../types";
import { cleanMessageContent, dayKey, formatDayLabel } from "../../utils";

type DayEntry = { type: "day"; key: string; label: string };
type MessageEntry = { type: "message"; message: Message; similar: Message[] };
export type FeedEntry = DayEntry | MessageEntry;

/** Texts this short are too common ("天气") to be treated as the same story. */
const MIN_GROUPED_TEXT = 7;

/**
 * Lays messages out under a divider per day. With `groupDuplicates` a message
 * whose text equals an earlier one's is folded into it as a "similar" message,
 * so the same wire story posted by several sources shows up once. A day's
 * divider appears only once something of that day is actually shown.
 */
export function groupMessages(messages: Message[], groupDuplicates: boolean): FeedEntry[] {
  const entries: FeedEntry[] = [];
  const firstWithText = new Map<string, MessageEntry>();
  let currentDay = "";
  let dayToShow: DayEntry | null = null;

  for (const message of messages) {
    const day = dayKey(message.message_time);
    if (day !== currentDay) {
      currentDay = day;
      dayToShow = { type: "day", key: `day-${day}`, label: formatDayLabel(message.message_time) };
    }

    const entry: MessageEntry = { type: "message", message, similar: [] };
    if (groupDuplicates) {
      const text = cleanMessageContent(message.content).trim();
      const earlier = message.content && message.content.trim().length >= MIN_GROUPED_TEXT ? firstWithText.get(text) : undefined;
      if (earlier) {
        earlier.similar.push(message);
        continue;
      }
      if (!firstWithText.has(text)) firstWithText.set(text, entry);
    }

    if (dayToShow) {
      entries.push(dayToShow);
      dayToShow = null;
    }
    entries.push(entry);
  }
  return entries;
}
