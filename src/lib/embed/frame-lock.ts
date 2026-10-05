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

import { makeCachedSwitchReader, type SwitchTimer } from "@/lib/cached-switch";

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
export type LockTimer = SwitchTimer;

/**
 * The frame lock's reader: the shared cached switch reader (`src/lib/cached-switch.ts`,
 * #3325) with the policy described above, a failed read HELD for the TTL like a good
 * one, and no lock when nothing good was ever read.
 */
export function makeFrameLockReader(deps: {
  read: () => Promise<boolean>;
  now: () => number;
  onError: (err: unknown) => void;
  timer?: LockTimer;
}): () => Promise<boolean> {
  const read = makeCachedSwitchReader({
    label: "frame lock",
    read: deps.read,
    now: deps.now,
    onError: deps.onError,
    timer: deps.timer,
    ttlMs: FRAME_LOCK_TTL_MS,
    readDeadlineMs: FRAME_LOCK_READ_DEADLINE_MS,
    fallback: () => false,
    onFailure: { kind: "hold" },
  });
  return async () => (await read()).on;
}
