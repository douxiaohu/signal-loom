import { useEffect, useState } from "react";
import { safeStorage } from "../lib/storage";
const key = "signal-saved-ids";
const event = "signal-library-change";
export function readSavedIds(): number[] {
  try {
    const value: unknown = JSON.parse(safeStorage.get(key) || "[]");
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (id): id is number => Number.isSafeInteger(id) && id > 0,
            ),
          ),
        ].slice(0, 500)
      : [];
  } catch {
    return [];
  }
}
function write(ids: number[]) {
  safeStorage.set(key, JSON.stringify(ids.slice(0, 500)));
  window.dispatchEvent(new Event(event));
}
export function useReaderLibrary() {
  const [ids, setIds] = useState(readSavedIds);
  useEffect(() => {
    const sync = () => setIds(readSavedIds());
    window.addEventListener(event, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(event, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return {
    ids,
    toggle: (id: number) => {
      const current = readSavedIds();
      write(
        current.includes(id)
          ? current.filter((value) => value !== id)
          : [id, ...current],
      );
    },
    remove: (values: number[]) =>
      write(readSavedIds().filter((id) => !values.includes(id))),
  };
}
