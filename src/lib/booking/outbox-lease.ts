import { log } from "../log.ts";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import type { OutboxStep } from "@/lib/db/types";

/**
 * The outbox row's lease, and every write that lease guards (#1048).
 *
 * A drain (or the inline path right after a booking mutation) takes a row's lease
 * before running its steps, so only one holder acts on a row at a time. That is what
 * lets the executor write the WHOLE steps array on each step: a single holder cannot
 * race itself.
 *
 * The release used to clear `lease_until` unconditionally by row id, which breaks the
 * one invariant the rest of the file rests on. A holder that overran the TTL released
 * a lease it no longer owned, and the moment it no longer owns it is exactly the
 * moment a second holder legitimately has it, so nulling that lease lets a third
 * start while the second is mid flight. Two live holders then write whole steps
 * arrays over each other: a stale copy re-opens a step that already ran and erases
 * the failure text of one that did not.
 *
 * So every write here is a compare and swap on the token. `releaseLock` and the
 * reschedule takeover next door already work this way; this brings the outbox in
 * line with them.
 *
 * Extracted from `realDeps` as a `db`-injected seam (the same reason
 * `claimRescheduleLock` was, #480) so the gating is unit-tested rather than being the
 * one part of the change nothing can see:
 * `scripts/test-outbox-lease.ts`.
 */

/** How long a holder owns a row. Long enough for a slow Google call inside a step,
 *  short enough that a crashed holder's row is picked up on a later tick. */
export const OUTBOX_LEASE_TTL_MS = 2 * 60 * 1000;

/**
 * What a lease-gated write did. Three outcomes, never collapsed into a boolean,
 * because a lost lease and a broken database call for opposite reactions and reading
 * the same is how one answers for the other (L11):
 *
 *   written    the row is still ours and the write landed
 *   lease-lost another holder owns the row now; stop touching it, and do not retry
 *   failed     the write itself errored; stop, and let the row be retried later
 */
export type OutboxWriteOutcome = "written" | "lease-lost" | "failed";

/**
 * The client these writes run on. Typed as the real Supabase client rather than a
 * hand-written slice of it: a structural interface here makes tsc walk the client's
 * generics at every call site and it gives up (TS2589). `claimRescheduleLock` takes
 * its `db` the same way, and its test casts a fake in, which is what
 * `scripts/test-outbox-lease.ts` does too.
 */
export type OutboxLeaseDb = ReturnType<typeof supabaseAdmin>;

/**
 * Take a row's lease, and return the TOKEN every later write is gated on, or null
 * when somebody else holds it.
 *
 * The token is the value the DATABASE reports, read back from the same statement
 * that wrote it, never the ISO string we sent. A store that renders a timestamp its
 * own way would otherwise make every subsequent equality check quietly false, which
 * would look exactly like permanently losing the lease.
 */
export async function leaseOutboxRow(
  db: OutboxLeaseDb,
  id: string,
  now: number,
): Promise<string | null> {
  const leaseUntil = new Date(now + OUTBOX_LEASE_TTL_MS).toISOString();
  // The gate: claim only a lease that is free or expired, so two claimants cannot
  // both win (the loser updates zero rows).
  const { data, error } = await db
    .from("booking_outbox")
    .update({ lease_until: leaseUntil })
    .eq("id", id)
    .or(`lease_until.is.null,lease_until.lt.${new Date(now).toISOString()}`)
    .select("lease_until");
  if (error) {
    // A claim we cannot confirm is not a claim. Reported rather than swallowed: the
    // row simply waits for the next tick, and a persistent failure is visible.
    log.warn("outbox", { msg: "lease claim failed", outbox_id: id }, error);
    return null;
  }
  const rows = (data ?? []) as { lease_until: string | null }[];
  return rows.length > 0 ? (rows[0]?.lease_until ?? null) : null;
}

/** Persist the steps array, only while this holder still owns the row. */
export async function saveOutboxStepsRow(
  db: OutboxLeaseDb,
  id: string,
  steps: OutboxStep[],
  lease: string,
  now: number,
): Promise<OutboxWriteOutcome> {
  return gatedWrite(db, id, lease, { steps, updated_at: new Date(now).toISOString() }, "save steps");
}

/** Mark the row delivered and drop its lease in one statement, only while this
 *  holder still owns it: a stale holder must not be able to declare delivery over a
 *  live holder that has steps left to run. */
export async function markOutboxDeliveredRow(
  db: OutboxLeaseDb,
  id: string,
  lease: string,
  now: number,
): Promise<OutboxWriteOutcome> {
  return gatedWrite(
    db,
    id,
    lease,
    { status: "delivered", lease_until: null, updated_at: new Date(now).toISOString() },
    "mark delivered",
  );
}

/**
 * Release the lease, only when the row still holds the token we wrote.
 *
 * A release that matches nothing is correct and silent: giving up a lease you no
 * longer hold is a no-op, and that no-op is the entire point.
 */
export async function releaseOutboxLeaseRow(
  db: OutboxLeaseDb,
  id: string,
  lease: string,
): Promise<void> {
  const { error } = await db
    .from("booking_outbox")
    .update({ lease_until: null })
    .eq("id", id)
    .eq("lease_until", lease)
    .select("id");
  if (error) {
    // Nothing to do about it here: the lease expires on its own, so the row is
    // recoverable either way. Said out loud so a database that is refusing writes is
    // not invisible on this path.
    log.warn("outbox", { msg: "lease release failed", outbox_id: id }, error);
  }
}

/** The shared compare and swap: update the row only while `lease_until` is still the
 *  token this holder wrote, and report which of the three things happened. */
async function gatedWrite(
  db: OutboxLeaseDb,
  id: string,
  lease: string,
  values: Record<string, unknown>,
  what: string,
): Promise<OutboxWriteOutcome> {
  const { data, error } = await db
    .from("booking_outbox")
    .update(values)
    .eq("id", id)
    .eq("lease_until", lease)
    .select("id");
  if (error) {
    log.warn("outbox", { msg: `${what} failed`, outbox_id: id }, error);
    return "failed";
  }
  return ((data ?? []) as unknown[]).length > 0 ? "written" : "lease-lost";
}
