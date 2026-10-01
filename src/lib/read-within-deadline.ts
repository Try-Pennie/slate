/**
 * One deadline for a read, shared rather than hand rolled per caller (#2982): it
 * reports a failure exactly once and clears its timer however the race ends, both
 * of which a bare `setTimeout` beside a `Promise.race` gets wrong.
 *
 * Pure, no `@/` imports, so node tests load it directly.
 */

/** Starts a timer and returns the function that clears it. Injected in tests. */
export type ScheduleTimer = (ms: number, fire: () => void) => () => void;

export const realTimer: ScheduleTimer = (ms, fire) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

/**
 * A read under a deadline, shared by every bounded read that must not hold a page
 * or a lane up: the calling number reads (lead facing and the reminder lane's
 * batched one), the advisor card photo, and the rebook lookup (#2982).
 * Null on a refusal or a timeout, each reported through `onUnread`, and the timer
 * cleared however the race ends.
 */
export async function readWithinDeadline<T>(
  read: () => Promise<T | null>,
  ms: number,
  onUnread: (err: unknown) => void,
  timer: ScheduleTimer = realTimer,
): Promise<T | null> {
  const TIMED_OUT = Symbol("timed out");
  // Reported exactly ONCE per read, whichever way it ends first: a read that timed
  // out and rejects later has already been reported, and saying so twice would read
  // in the logs as two failures (L467).
  let reported = false;
  const report = (err: unknown) => {
    if (reported) return;
    reported = true;
    onUnread(err);
  };
  const attempt = read().catch((err: unknown) => {
    report(err);
    return null;
  });
  let cancel = () => {};
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    cancel = timer(ms, () => resolve(TIMED_OUT));
  });
  try {
    const got = await Promise.race([attempt, expired]);
    if (got === TIMED_OUT) {
      report(new Error(`no answer within ${ms}ms`));
      return null;
    }
    return got;
  } finally {
    cancel();
  }
}
