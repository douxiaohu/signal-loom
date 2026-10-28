import { useEffect, useRef, type MutableRefObject } from "react";

/**
 * A ref that always holds the value from the latest render. It lets timers,
 * event handlers and async callbacks read fresh props and callbacks without
 * being re-created (or re-subscribed) every time those change.
 *
 * It is updated in an effect, so hooks that read it from their own effects must
 * be declared after it to see the value of the current commit.
 */
export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
