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
