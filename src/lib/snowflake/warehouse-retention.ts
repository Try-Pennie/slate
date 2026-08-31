/**
 * The warehouse half of the 24 month booking PII window (#1180).
 *
 * Supabase has enforced this window since #1071: `prune-bookings-pii` redacts
 * aged contact data in place and stamps `pii_redacted_at`, which deliberately
 * FREEZES the row from re-export (#1118) so the mirror cannot clobber the
 * redaction. The consequence nobody closed until now: the redaction therefore
 * propagates NOWHERE, so the warehouse kept a full fidelity copy indefinitely and
 * the retention limit Pennie has committed to in writing was half enforced.
 *
 * That commitment is not aspirational. `docs/pii-retention.md` section 9 records
 * the position as CONFIRMED (2026-07-29, #1074) and states it applies to the
 * mirror as well, and `docs/pii-legal-positions.md`, written for counsel, says the
 * same. Until this lane existed that document overstated what the system did.
 *
 * THREE THINGS DECIDE THE DESIGN, and each was a live question on the issue:
 *
 * 1. The credential is sufficient. The export role holds SELECT, INSERT and
 *    UPDATE and withholds only DELETE (docs/snowflake-setup.sql), so "append
 *    only" here means "cannot remove rows", not "cannot write". Retention is
 *    redact-in-place, which is an UPDATE, so no second role and no operator run
 *    job is needed (#1128 established the same for the deletion-request purge).
 *
 * 2. It needs no marker column, and therefore no warehouse DDL. The obvious
 *    problem is that the mirror has no equivalent of `pii_redacted_at`, so there
 *    is nothing recording which rows this sweep has already done. It does not
 *    need one: "past the window and not yet cleared" is directly observable in the
 *    data, which is how the runbook's own verify asks the question and how the
 *    Supabase lane stays idempotent. The predicate is self limiting, so a re-run
 *    finds strictly less and an interrupted run resumes by itself.
 *
 * 3. It shares the statements with the deletion-request purge rather than owning
 *    a copy. The two differ ONLY in which rows they select, and a second copy of
 *    the field list is a second chance to miss a column, which is precisely what
 *    #1205 (`webhook_deliveries.last_response`) and #1207 (`booking_outbox.steps`)
 *    each were. `runPurgeAndVerify` is the shared core (L41).
 *
 * WHAT IT MUST NOT TOUCH. `updated_at` and `exported_at` are the mirror's own
 * bookkeeping: `updated_at` mirrors Supabase and is what `buildVerifySql`'s
 * is_current comparison reads to decide whether a row is safely archived, and
 * `exported_at` is the load stamp. Writing either would corrupt the machinery the
 * Supabase-side retention lane depends on to know what it may redact. The shared
 * statements do not name them, and a test asserts that rather than trusting it.
 *
 * ORDER IS SAFE IN BOTH DIRECTIONS. Clearing the warehouse first cannot deadlock
 * `prune-bookings-pii`: that lane refuses to redact a row the warehouse has not
 * confirmed, but `buildVerifySql` asks only whether the id is PRESENT and whether
 * the watermark is current, never whether a contact column holds anything, so a
 * redacted warehouse row still verifies as archived.
 */

import { readSnowflakeConfig } from "./config";
import { escapeSqlLiteral, executeStatement } from "./client";
import { runPurgeAndVerify } from "./purge";
import { bookingPiiCutoffIso } from "@/lib/booking/pii-retention";
import { log } from "@/lib/log";

/**
 * Bookings cleared per run. Bounded so one tick cannot build an unbounded
 * statement, and the predicate is self limiting, so a backlog drains over
 * successive days rather than needing a big-bang run. There is no backlog today:
 * Slate's oldest bookings are from June 2026, so nothing reaches 24 months until
 * mid 2028, and this exists to be already working when it does.
 */
export const WAREHOUSE_RETENTION_BATCH = 500;

export interface WarehouseRetentionOutcome {
  /** Set when the sweep could not run at all, naming which case. */
  skipped?: "mirror-not-configured";
  /** The window boundary this run used. */
  cutoff?: string;
  /** Aged bookings still holding contact data that this run selected. */
  candidates: number;
  /** Bookings whose contact data the sweep cleared. */
  cleared: number;
  /** Rows changed per mirror table, for the run log. */
  rowsByTable: Record<string, number>;
}

/**
 * Aged bookings in the warehouse that still hold contact data.
 *
 * THROWS when Snowflake's answer has no data block, because an empty list and an
 * unreadable answer are opposite facts here: the first means retention is up to
 * date and the second means we do not know, and a sweep that reported "nothing
 * aged" for an unreadable answer would look identical to a healthy run forever
 * (L98).
 *
 * The predicate names the three scalar contact columns rather than just
 * `attendee_email`. All four are cleared by one statement, so a row selected on
 * any of them has its `prefill` cleared too; keying on email alone would miss a
 * row that somehow held a name or phone without one, since the column is
 * nullable. A row holding ONLY a non-empty `prefill` is not reachable by this
 * predicate, which is a known and bounded gap: no producer writes prefill without
 * also writing at least one of the three.
 */
async function selectAgedBookings(
  config: Parameters<typeof runPurgeAndVerify>[0],
  cutoffIso: string,
  limit: number,
): Promise<string[]> {
  const sql =
    `select id from SLATE.PUBLIC.bookings\n` +
    ` where starts_at < '${escapeSqlLiteral(cutoffIso)}'\n` +
    `   and (attendee_email is not null or attendee_name is not null or attendee_phone is not null)\n` +
    ` order by starts_at\n` +
    ` limit ${limit}`;
  const res = await executeStatement(config, sql);
  if (!res.data) {
    throw new Error(
      "warehouse retention: the aged-booking select returned no data block, so which rows are past " +
        "the window could not be read (an empty result and an unreadable one are not the same)",
    );
  }
  return res.data.map((row) => String(row[0]));
}

/**
 * Clear contact data from warehouse bookings whose appointment is past the 24
 * month window, then verify nothing is left.
 *
 * `nowIso` is injected rather than read from the clock so the window boundary is
 * a fixed value under test rather than whatever today happens to be (L130).
 *
 * Fails loud on every uncertainty: an unreadable select, an unreadable row count,
 * and a verify that still finds contact data all THROW. The lane above turns a
 * throw into a 500 and withholds its heartbeat, which goes stale and pages, so a
 * sweep that stops honoring the window cannot sit quiet. A "cleared 0" result is
 * reserved for the one case that genuinely means it: nothing was aged.
 */
export async function sweepWarehousePii(
  nowIso: string,
  limit: number = WAREHOUSE_RETENTION_BATCH,
): Promise<WarehouseRetentionOutcome> {
  const config = readSnowflakeConfig();
  if (!config) {
    return { skipped: "mirror-not-configured", candidates: 0, cleared: 0, rowsByTable: {} };
  }

  const cutoff = bookingPiiCutoffIso(nowIso);
  const ids = await selectAgedBookings(config, cutoff, limit);
  if (ids.length === 0) {
    log.info("prune-warehouse-pii", { msg: "nothing past the window", cutoff });
    return { cutoff, candidates: 0, cleared: 0, rowsByTable: {} };
  }

  const { rowsByTable, reasons, ok } = await runPurgeAndVerify(config, ids, "warehouse retention");
  if (!ok) {
    // The statements ran and the data is still there. That is the control having
    // failed, not a smaller success, and reporting a cleared count would certify a
    // window that is not being honored.
    throw new Error(`warehouse retention: the sweep ran and did not clear everything. ${reasons.join("; ")}`);
  }

  log.info("prune-warehouse-pii", {
    msg: "cleared",
    cutoff,
    candidates: ids.length,
    ...rowsByTable,
  });
  return {
    cutoff,
    candidates: ids.length,
    cleared: rowsByTable.bookings ?? 0,
    rowsByTable,
  };
}
