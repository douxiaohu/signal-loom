import { useState, type FormEvent } from "react";

/** The busy / error bookkeeping of a form whose submit is an async action. */
export function useAsyncSubmit(fallbackError: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /** Runs `work` for a submit event; a failure stays in `error` and the caller keeps what was typed. */
  async function submit(event: FormEvent, work: () => Promise<void>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallbackError);
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, submit };
}
