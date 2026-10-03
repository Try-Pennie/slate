import { log } from "../log.ts";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import type { OutboxStep } from "@/lib/db/types";
import { gatedWriteRows } from "./gated-write.ts";

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
 *
 * The booking reservation carries the same kind of lease and had the same defect
 * (#3169): its release cleared `lease_until` by row id, so an overrunning drain
 * could free a newer holder's lease and two attempts would work one lead's booking
 * at once. It takes and releases its lease through the claim and release below
 * rather than a second copy of them (L41), so the two tables cannot drift apart
 * again: `scripts/test-reservation-lease.ts`.
 */

/** The tables whose rows carry a `lease_until` token this file gates on. */
export type LeasedTable = "booking_outbox" | "booking_reservations";

/** How long a holder owns a row. Long enough for a slow Google call inside a step,
 *  short enough that a crashed holder's row is picked up on a later tick. */
export const OUTBOX_LEASE_TTL_MS = 2 * 60 * 1000;

/** How long a reservation drain owns a reservation (#429 P4). Crash during create is
 *  rare, so this only governs how soon an orphaned reservation is retried. */
export const RESERVATION_LEASE_TTL_MS = 2 * 60 * 1000;

/** Each table's lease length, log tag and id field. The length lives here because
 *  the release derives the claim instant from the token (see `releaseLeaseRow`). */
const LEASED: Record<LeasedTable, { ttlMs: number; tag: string; idField: string }> = {
  booking_outbox: { ttlMs: OUTBOX_LEASE_TTL_MS, tag: "outbox", idField: "outbox_id" },
  booking_reservations: { ttlMs: RESERVATION_LEASE_TTL_MS, tag: "reservations", idField: "reservation_id" },
};

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
  const { data, error } = await claimLeaseRow(db, "booking_outbox", id, now);
  if (error) {
    // A claim we cannot confirm is not a claim. Reported rather than swallowed: the
    // row simply waits for the next tick, and a persistent failure is visible.
    log.warn("outbox", { msg: "lease claim failed", outbox_id: id }, error);
    return null;
  }
  return leaseToken(data);
}

/**
 * Take a booking reservation's lease, and return its token, or null when another
 * holder has it (#3169).
 *
 * Unlike the outbox claim, a refused statement THROWS (#2373): a reservation that
 * reads as busy while the database is refusing writes looks exactly like the drain
 * coalescing correctly, and nobody hears about it.
 */
export async function leaseReservationRow(
  db: OutboxLeaseDb,
  id: string,
  now: number,
): Promise<string | null> {
  return leaseToken(
    gatedWriteRows("reservation_lease", await claimLeaseRow(db, "booking_reservations", id, now)),
  );
}

/** Release a reservation's lease, only while it still holds the token we wrote. */
export async function releaseReservationLeaseRow(
  db: OutboxLeaseDb,
  id: string,
  lease: string,
): Promise<void> {
  await releaseLeaseRow(db, "booking_reservations", id, lease);
}

/**
 * The one claim statement both tables use: take the lease only when it is free or
 * expired, so two claimants cannot both win (the loser updates zero rows), and read
 * the token back from the same statement.
 *
 * Every token a row hands out is strictly later than the one before it, so no two
 * holders ever share one. A claim needs the stored value strictly before its OWN
 * instant: after a takeover that value was the old token, and after a release it is
 * the old claim instant (`releaseLeaseRow`), so either way the new token, the claim
 * instant plus the same TTL, is later. It holds whichever holder's clock is ahead,
 * because the comparison is against what is stored. A row marked delivered is
 * cleared to null instead, which is safe because nothing claims a delivered row.
 */
function claimLeaseRow(db: OutboxLeaseDb, table: LeasedTable, id: string, now: number) {
  return db
    .from(table)
    .update({ lease_until: new Date(now + LEASED[table].ttlMs).toISOString() })
    .eq("id", id)
    .or(`lease_until.is.null,lease_until.lt.${new Date(now).toISOString()}`)
    .select("lease_until");
}

/** The token a claim returned, or null when it touched no row. */
function leaseToken(data: unknown[] | null): string | null {
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
  await releaseLeaseRow(db, "booking_outbox", id, lease);
}

/**
 * The one release statement both tables use: free the lease only while the row
 * still holds `lease`, so a holder that overran never frees its successor's.
 *
 * Freeing writes the CLAIM INSTANT (the token less the TTL) rather than null. That
 * instant is already past, so the row is free to the next claim, and a claim in the
 * same millisecond is refused, so it can never be handed this holder's token again.
 * A token that will not parse, which nothing here writes, falls back to null.
 */
async function releaseLeaseRow(
  db: OutboxLeaseDb,
  table: LeasedTable,
  id: string,
  lease: string,
): Promise<void> {
  const tokenMs = Date.parse(lease);
  const freedAt = Number.isFinite(tokenMs) ? new Date(tokenMs - LEASED[table].ttlMs).toISOString() : null;
  const { error } = await db
    .from(table)
    .update({ lease_until: freedAt })
    .eq("id", id)
    .eq("lease_until", lease)
    .select("id");
  if (error) {
    // Nothing to do about it here: the lease expires on its own, so the row is
    // recoverable either way. Said out loud so a database that is refusing writes is
    // not invisible on this path.
    const { tag, idField } = LEASED[table];
    log.warn(tag, { msg: "lease release failed", [idField]: id }, error);
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
