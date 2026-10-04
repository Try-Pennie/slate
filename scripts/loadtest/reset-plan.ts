/**
 * The reset between load run arms (#3258), as a plan over an injected client so
 * `scripts/test-loadtest-reset.ts` drives every step with no database.
 *
 * Why it exists: the three arms of the post confirm recompute experiment share one
 * branch and one deployment, which saves a fresh environment's secrets and its
 * wait for the first cron delivery per arm. That is only a fair comparison if each
 * arm starts where the first did. The previous arm's bookings make agents busier
 * (busy blocks, daily caps) and widen every candidate read; its leftover outbox
 * rows and reservations are drained by the lanes during the next arm; and its rate
 * limit rows can refuse the next arm's drivers, which run at the per address
 * ceiling.
 *
 * DELETE, never TRUNCATE. `busy_blocks.booking_id` cascades on delete, so deleting
 * bookings removes only the busy time a booking wrote; a TRUNCATE ... CASCADE would
 * empty the whole table, the seeded calendar busy time with it, and the next arm
 * would run against a different calendar. Bookings go first because the other
 * booking tables only null their reference when a booking is deleted
 * (booking_outbox, pending_event_deletions, routing_decisions) or carry none
 * (booking_reservations, rate_limits).
 *
 * `bulk_reassign_items.booking_id` references bookings with NO delete rule, so a
 * row there would make the bookings delete fail half way. The bulk reassign lane is
 * disabled in the load test environment, so a row means something unexpected
 * happened on this branch: the reset refuses, naming it, before deleting anything,
 * rather than deleting evidence nobody has looked at.
 */

/** The tables the reset empties, in the order it empties them. */
export const RESET_ORDER = [
  "bookings",
  "booking_outbox",
  "booking_reservations",
  "pending_event_deletions",
  "routing_decisions",
  "rate_limits",
] as const;
export type ResetTable = (typeof RESET_ORDER)[number];

/** The database calls the reset makes, injected so a test can stand in for them. */
export interface ResetClient {
  /** The first bulk reassign row on the branch (item or job), or null when none. */
  firstBulkReassignRow(): Promise<{ table: string; id: string } | null>;
  /** Delete every row of `table`, answering how many were deleted. Throws on failure. */
  deleteAll(table: ResetTable): Promise<number>;
}

export type ResetResult =
  | { ok: true; deleted: { table: ResetTable; rows: number }[] }
  | { ok: false; why: string };

export async function resetBranch(client: ResetClient): Promise<ResetResult> {
  const bulk = await client.firstBulkReassignRow();
  if (bulk) {
    return {
      ok: false,
      why:
        `${bulk.table} holds row ${bulk.id}. The bulk reassign lane is off in the load test ` +
        `environment, so this row is unexpected; nothing was deleted. Find out where it came ` +
        `from before resetting.`,
    };
  }
  const deleted: { table: ResetTable; rows: number }[] = [];
  for (const table of RESET_ORDER) deleted.push({ table, rows: await client.deleteAll(table) });
  return { ok: true, deleted };
}
