/**
 * The frame lock switch, as the middleware reads it (#3137).
 *
 * The lock is `booking_settings.frame_lock_enabled` (migration 0160), flipped on the
 * admin Embedding page with no deploy, the way the public booking pause is. It is
 * read here rather than per request because the middleware runs on EVERY booker
 * load, the hot path: one single row read per isolate every `FRAME_LOCK_TTL_MS`
 * costs nothing a lead can feel, and a flip still lands within seconds.
 *
 * WHICH WAY IT FAILS. An unreadable switch keeps the last value this isolate read,
 * and with none it is OFF. Failing closed here would black out the booker on every
 * partner page for the length of a database blip, where the only error is in a
 * console nobody at Pennie sees, while the booker itself needs the database to do
 * anything at all. The failure is reported every time, and retried on the next
 * request rather than cached, so a blip costs one read per request until it clears.
 *
 * Pure apart from its injected read and clock, so scripts/test-frame-lock.ts drives it.
 */

/** How long one read of the switch stands in an isolate. */
export const FRAME_LOCK_TTL_MS = 15_000;

export function makeFrameLockReader(deps: {
  read: () => Promise<boolean>;
  now: () => number;
  onError: (err: unknown) => void;
}): () => Promise<boolean> {
  let known: { value: boolean; readAtMs: number } | null = null;
  let inFlight: Promise<boolean> | null = null;

  return async () => {
    if (known && deps.now() - known.readAtMs < FRAME_LOCK_TTL_MS) return known.value;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const value = await deps.read();
        known = { value, readAtMs: deps.now() };
        return value;
      } catch (err) {
        deps.onError(err);
        return known?.value ?? false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
