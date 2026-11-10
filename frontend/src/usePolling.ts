/**
 * A React "hook": load data now, then again every few seconds, so the page
 * stays fresh without the user pressing reload.
 *
 * `load` must not change on every render (pass a fixed function, or wrap it
 * in useCallback), otherwise the timer would restart constantly.
 */
import { useCallback, useEffect, useState } from "react";

export function usePolling<T>(load: () => Promise<T>, intervalMs = 10_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [load]);

  useEffect(() => {
    void refresh(); // load right away...
    const timer = setInterval(() => void refresh(), intervalMs); // ...then every intervalMs
    return () => clearInterval(timer); // stop when the page is closed
  }, [refresh, intervalMs]);

  return { data, error, refresh };
}
