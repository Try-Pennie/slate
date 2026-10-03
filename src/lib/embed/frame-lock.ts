/**
 * The frame lock switch, as the middleware reads it (#3137).
 *
 * The lock is `booking_settings.frame_lock_enabled` (migration 0162), flipped on the
 * admin Embedding page with no deploy, the way the public booking pause is. It is
 * read here rather than per request because the middleware runs on EVERY booker
 * load, the hot path: one single row read per isolate every `FRAME_LOCK_TTL_MS`
 * costs nothing a lead can feel, and a flip still lands within seconds.
 *
 * WHICH WAY IT FAILS. An unreadable switch keeps the last value this isolate read,
 * and with none it is OFF, which is how the booker has always run: a database blip on a
 * cold isolate must not lock out framing nobody turned on, and observing carries on
 * while the switch cannot be read. A failed read is CACHED for the TTL like a good one,
 * so an outage costs one failing call per isolate per TTL rather than one per booker
 * load, on a path that already needs the database for everything else. Every failure
 * is reported.
 *
 * Pure apart from its injected read, clock and timer, so scripts/test-frame-lock.ts drives it.
 */

/** How long one read of the switch stands in an isolate. */
export const FRAME_LOCK_TTL_MS = 15_000;

/** The same, in the whole seconds the admin copy quotes, so the copy cannot drift. */
export const FRAME_LOCK_TTL_SECONDS = Math.ceil(FRAME_LOCK_TTL_MS / 1000);

/**
 * How long the middleware waits for the switch before treating the read as failed. It
 * is awaited before every booker page renders, so a hung database must cost a lead no
 * more than this, once per isolate per TTL, rather than stalling the page until the
 * general Supabase deadline cuts it.
 */
export const FRAME_LOCK_READ_DEADLINE_MS = 500;

/** Starts a timer and returns the function that clears it. Injected in tests. */
export type LockTimer = (ms: number, fire: () => void) => () => void;

const realTimer: LockTimer = (ms, fire) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

export function makeFrameLockReader(deps: {
  read: () => Promise<boolean>;
  now: () => number;
  onError: (err: unknown) => void;
  timer?: LockTimer;
}): () => Promise<boolean> {
  let known: { value: boolean; readAtMs: number } | null = null;
  let inFlight: Promise<boolean> | null = null;
  const timer = deps.timer ?? realTimer;

  /** The read, raced against the deadline; a timeout rejects like any failed read. */
  const readWithinDeadline = () =>
    new Promise<boolean>((resolve, reject) => {
      const cancel = timer(FRAME_LOCK_READ_DEADLINE_MS, () =>
        reject(new Error(`frame lock read did not answer within ${FRAME_LOCK_READ_DEADLINE_MS}ms`)),
      );
      deps.read().then(
        (v) => {
          cancel();
          resolve(v);
        },
        (err: unknown) => {
          cancel();
          reject(err);
        },
      );
    });

  return async () => {
    if (known && deps.now() - known.readAtMs < FRAME_LOCK_TTL_MS) return known.value;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const value = await readWithinDeadline();
        known = { value, readAtMs: deps.now() };
        return value;
      } catch (err) {
        deps.onError(err);
        const value = known?.value ?? false;
        known = { value, readAtMs: deps.now() };
        return value;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
