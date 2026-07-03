import { useEffect, useState } from "react";

/**
 * Watchdog for a time-taking async action. While `active` is true, flips the
 * returned flag to true after `ms` so the UI can show a distinct "still working"
 * state instead of an unchanging label — the middle of the three states every
 * time-taking action must have (started / still-alive / failed). Resets the
 * instant the action ends so the next run starts clean.
 *
 * Extracted from OooForm's inline watchdog (#626) so booking confirm, manage
 * cancel/reschedule, admin actions, and login all share one implementation.
 */
export function useStalledAfter(active: boolean, ms = 10000): boolean {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    if (!active) return;
    // Set only asynchronously (timeout) or on cleanup — a synchronous setState in
    // the effect body would trip the cascading-render guard. Cleanup runs when
    // `active` flips off (or on unmount), resetting so the next run starts clean.
    const t = setTimeout(() => setStalled(true), ms);
    return () => {
      clearTimeout(t);
      setStalled(false);
    };
  }, [active, ms]);

  return stalled;
}
