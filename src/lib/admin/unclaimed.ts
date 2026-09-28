import { parseStampMs } from "../date/stamp.ts";
import type { User } from "../db/types.ts";

/**
 * A roster row nobody has ever signed in to, and how long it has waited (#1802).
 *
 * `auth_user_id` is null until a Google sign in links the row (`provision.ts`), so
 * it is the recorded fact. The avatar is NOT: since #2600 photos come from the
 * Workspace directory for people who have never logged in, and a person who signed
 * in with no photo always read as never having done so.
 *
 * Two surfaces ask this question, the pending access panel for privileged rows
 * (#160) and the agent roster for everybody. Both go through these helpers, so
 * the figure and its wording cannot come apart between them (L370).
 */
export function isNeverSignedIn(u: Pick<User, "auth_user_id">): boolean {
  return u.auth_user_id === null;
}

const DAY_MS = 86_400_000;

/**
 * Whole days between the row being created and `nowMs`.
 *
 * An unreadable `created_at` (a NOT NULL timestamptz the database writes, so this
 * is not expected) is 0 days rather than NaN: a 0 day wait understates rather than
 * inventing an alarm. A stamp ahead of the clock is 0, never negative.
 */
export function unclaimedDays(createdAt: string, nowMs: number): number {
  const createdMs = parseStampMs(createdAt);
  if (createdMs === null) return 0;
  return Math.max(0, Math.floor((nowMs - createdMs) / DAY_MS));
}

/** How long an unclaimed row has waited, as a sentence fragment. */
export function unclaimedWaitText(waitedDays: number): string {
  if (waitedDays <= 0) return "added today";
  if (waitedDays === 1) return "waiting 1 day";
  return `waiting ${waitedDays} days`;
}
