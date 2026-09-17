/**
 * Fail-loud unwrap for a Supabase/PostgREST result (#277).
 *
 * Reads used to destructure `const { data } = await db...` and ignore `error`:
 * when a query failed (e.g. a missing column on a half-applied migration) `data`
 * came back null, the availability pool collapsed to empty and the booker
 * silently showed NO availability, or the SF roster sync (#963) treated the read
 * as an empty roster and re-inserted every agent. Either way a broken deploy
 * looked like a quiet day. Routing the critical reads through `unwrap` turns that
 * into a thrown error the caller (and our cron alerting) surfaces, instead of a
 * degrade.
 *
 * A null `data` with a null `error` is NOT a failure — it's "not found"
 * (`maybeSingle()`, an empty select). unwrap passes that through so the
 * caller's own null-handling still runs; it throws ONLY on a real `error`.
 *
 * Pure + dependency-free so it's node-testable (scripts/test-db-result.ts).
 */
import { log } from "@/lib/log";

export interface DbResult<T> {
  data: T;
  error: { message: string } | null;
}

export function unwrap<T>(res: DbResult<T>, context: string): T {
  if (res.error) {
    throw new Error(`read failed [${context}]: ${res.error.message}`);
  }
  return res.data;
}

/**
 * The count-shaped sibling of `unwrap` (#1165).
 *
 * A PostgREST result asked for `{ count: "exact" }` reports a FAILED query as
 * `count: null`, and the `count ?? 0` that every call site writes then turns the
 * failure into a perfectly healthy-looking "0 rows affected". That is the same
 * defect as #277 wearing a different shape: the pool-exit prune reported
 * `blocksDeleted: 0` on a delete that never ran, so the stale cached busy time
 * the #248 backstop exists to remove lingered with nothing noticing.
 *
 * A null count with a null error is NOT a failure: it is "no count was asked
 * for" / "nothing matched", so it passes through as 0. Only a real `error`
 * throws.
 */
export interface DbCountResult {
  count: number | null;
  error: { message: string } | null;
}

export function unwrapCount(res: DbCountResult, context: string): number {
  if (res.error) {
    throw new Error(`count failed [${context}]: ${res.error.message}`);
  }
  return res.count ?? 0;
}

/** Postgres `unique_violation`. */
export const UNIQUE_VIOLATION = "23505";

/**
 * Whether a Supabase/PostgREST error is a unique key refusing a duplicate row
 * (#1648).
 *
 * This is the answer to "assume it runs twice": a read that correctly returned
 * nothing is no protection, because two concurrent callers can both pass it, so
 * the key is what actually makes the second write impossible. A caller that gets
 * this back has LOST a race it was always allowed to lose; the right response is
 * to re-read and use the row that won, never to retry the insert and never to
 * treat it as the caller's own failure.
 *
 * Any other error is a real failure and must stay one: this deliberately matches
 * on the SQLSTATE rather than on the message, so a differently worded duplicate
 * error is still caught and an unrelated error is never mistaken for one.
 */
export function isUniqueViolation(
  error: { code?: string } | null | undefined,
): boolean {
  return error?.code === UNIQUE_VIOLATION;
}

/** Postgres `exclusion_violation`, raised by an EXCLUDE constraint. */
export const EXCLUSION_VIOLATION = "23P01";

/**
 * Whether a write was refused because the SLOT is already taken (#2274).
 *
 * TWO codes, because two guards answer that one question about bookings and they
 * are not interchangeable:
 *
 *   `bookings_active_slot_uniq` refuses a second booking at the SAME start for one
 *   agent, and raises 23505;
 *
 *   `bookings_active_no_overlap` refuses a second booking OVERLAPPING an existing
 *   one for that agent, and raises 23P01. Appointments are longer than the grid
 *   they are offered on (20 minutes every 10 in production), so adjacent offered
 *   times overlap and uniqueness on the start cannot see it. That is the defect
 *   the first concurrent load run found.
 *
 * Both mean the same thing to a lead, and the distinction must not reach them: a
 * caller getting either has LOST a race it was always allowed to lose, and the
 * honest answer is to offer another time. Mapping only one of them would make a
 * real race answer a server error instead, which is a failure that is both louder
 * and wronger than the one it replaced.
 *
 * Matched on the SQLSTATE and never on the message, so a differently worded
 * refusal is still caught and an unrelated error is never mistaken for one. Every
 * other code stays a real failure: telling a lead to pick another time when the
 * write never had a chance is a lie about what happened (L11).
 */
export function isSlotClash(
  error: { code?: string } | null | undefined,
): boolean {
  return error?.code === UNIQUE_VIOLATION || error?.code === EXCLUSION_VIOLATION;
}

/**
 * Report a write that was allowed to fail, so its failure is at least VISIBLE (#2482).
 *
 * For the narrow case where a refusal genuinely degrades to something safe and the
 * degradation is worth seeing: a counter that did not advance, a lease that will now
 * expire on its timeout instead of being released, a stamp the next pass rewrites. The
 * call site still carries the reason in a `// write-ok:` comment; this is what stops the
 * refusal being invisible as well as tolerated.
 *
 * It is deliberately NOT a blanket way to silence the unchecked write guard. It logs, so
 * every use costs a line somebody can find, and a write whose failure loses something
 * (an intent nobody re-records, a pin nothing else can reconstruct, a row nothing
 * re-inserts) must throw instead. Putting a second class of write behind this one would
 * widen it into exactly the silence it exists to remove (L448).
 */
export function reportWriteFailure(
  res: { error: { message: string } | null } | null | undefined,
  context: string,
): void {
  const error = res?.error;
  if (!error) return;
  log.warn("db-write", { msg: "tolerated write failure", context, reason: error.message });
}
