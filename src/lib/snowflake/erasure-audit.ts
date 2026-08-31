/**
 * Erasure content audit for the Snowflake mirror (#1103, Workstream C).
 *
 * The Snowflake half of a DSR erasure is a deliberate, separately triggered step,
 * and the count reconcile (#1101) is structurally blind to whether it happened: a
 * redacted-in-place row and a full-fidelity one have the SAME row count, so a
 * warehouse that still holds an erased person's PII reconciles as perfectly in
 * sync.
 *
 * This lane is the detective control that closes that gap. For every booking id
 * recorded in a `pii.erasure` audit entry, it asserts Snowflake holds NO residual
 * contact PII, and the cron route alerts loudly if it does.
 *
 * It reports; it does not remediate. What clears a residual is
 * `purgeSnowflakeErasure` (`purge.ts`), a deliberate operator action, and the two
 * are kept apart on purpose: this lane's job is to be the thing that notices, and
 * a check that silently fixes what it finds stops being able to tell you the
 * purge was ever missed. Note the export role CAN write the fix (#1128: it
 * withholds DELETE, not UPDATE), so this separation is a choice, not a limit.
 */

import { log } from "@/lib/log";
import { erasedIdsFrom, readBookingClasses, readErasureAuditRows } from "./erasure-trail";
import { readSnowflakeConfig } from "./config";
import { escapeSqlLiteral, executeStatement, type SnowflakeConfig } from "./client";

export interface ErasureResidual {
  table: string;
  /** Rows in Snowflake that still hold PII for an erased booking. Must be 0. */
  residual: number;
}

/** Pure decision: any residual PII means the operator's warehouse purge is
 *  incomplete. Node/vitest-testable without any IO. */
export function evaluateErasureAudit(residuals: ErasureResidual[]): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const r of residuals) {
    if (r.residual > 0) {
      reasons.push(
        `${r.table}: ${r.residual} erased booking row(s) still hold contact PII in Snowflake (the operator's warehouse purge is incomplete or was clobbered)`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** One booking's class, as the bookings read returns it. */
export interface BookingClassRow {
  id: string;
  is_test: boolean;
}

export interface ErasedBookingClasses {
  /** Bookings whose residual PAGES. Includes anything unclassifiable. */
  realIds: string[];
  /** Bookings whose residual only whispers. */
  testIds: string[];
  /** Why some id could not be classified, or null when all of them were. */
  unreadable: string | null;
}

/**
 * Partition the erasure trail into real and test bookings (#1196).
 *
 * PURE, so the fallback direction can be driven directly rather than inferred
 * from a mocked query. `rows` is null when the read itself failed.
 *
 * EVERY uncertainty lands on REAL, and that asymmetry is the whole safety
 * argument. A residual on a synthetic SMOKE booking is an operational tidy-up on
 * fabricated data; a residual on a real booking is an incomplete data-subject
 * erasure with a response deadline. Guessing "test" on an id we could not read
 * would silently downgrade the second into the first, which is a protective
 * control failing open (L42), and the downgrade would be invisible because the
 * whisper looks exactly like a correctly-classified test residual.
 *
 * Two ways an id goes unread, and both fall to real: the whole read failed, or
 * the read succeeded and simply did not mention that id (a booking deleted since
 * the erasure, or one belonging to an org this read did not cover).
 */
export function classifyErasedBookings(
  ids: string[],
  rows: BookingClassRow[] | null,
): ErasedBookingClasses {
  if (!rows) {
    return {
      realIds: [...ids],
      testIds: [],
      unreadable: "the bookings read failed, so no id could be classified",
    };
  }
  const isTest = new Map(rows.map((r) => [r.id, r.is_test]));
  const realIds: string[] = [];
  const testIds: string[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const flag = isTest.get(id);
    if (flag === undefined) {
      unknown.push(id);
      realIds.push(id);
    } else if (flag) {
      testIds.push(id);
    } else {
      realIds.push(id);
    }
  }
  return {
    realIds,
    testIds,
    unreadable:
      unknown.length > 0
        ? `${unknown.length} booking(s) were not in the bookings read (${unknown.slice(0, 3).join(", ")})`
        : null,
  };
}

export interface ErasureAuditOutcome {
  skipped?: true;
  /**
   * Whether the REAL side is clean. This is what pages, and it deliberately
   * ignores the test side: a residual on a synthetic fixture must never hold a
   * compliance page open, and must never clear one either.
   */
  ok: boolean;
  erasedBookings: number;
  residuals: ErasureResidual[];
  reasons: string[];
  /** The bookings the real-side residuals belong to, for the alert copy (#1195). */
  realBookingIds: string[];
  /** The test side, reported separately so the lane can whisper instead of page. */
  testResiduals: ErasureResidual[];
  testReasons: string[];
  testBookingIds: string[];
  /** Set when some id fell back to real because its class could not be read. */
  classificationUnreadable: string | null;
}

async function countSnowflake(config: SnowflakeConfig, sql: string): Promise<number> {
  const res = await executeStatement(config, sql);
  return Number(res.data?.[0]?.[0] ?? 0);
}

/**
 * How much contact PII Snowflake still holds for a given set of erased bookings.
 *
 * Lifted out of the lane below (#1124) so the 6-hourly audit and the operator
 * worklist that renders the same number ask ONE question through one
 * implementation. Two readers would be two chances to disagree about what counts
 * as a residual, and the worklist's whole job is to show what this lane measures.
 *
 * It THROWS when Snowflake refuses, because a caller must never receive a zero
 * nobody measured: a zero here is what certifies a deletion request honored.
 */
export async function residualsForBookingIds(
  config: SnowflakeConfig,
  ids: string[],
): Promise<ErasureResidual[]> {
  // `ids` come from our own audit rows (uuids), never user input; still escape
  // them defensively before interpolating into the Snowflake statement.
  const idList = ids.map((id) => `'${escapeSqlLiteral(id)}'`).join(",");
  return [
    {
      table: "bookings",
      residual: await countSnowflake(
        config,
        `SELECT count(*) FROM bookings WHERE id IN (${idList}) AND attendee_email IS NOT NULL`,
      ),
    },
    {
      table: "booking_events",
      residual: await countSnowflake(
        config,
        `SELECT count(*) FROM booking_events WHERE booking_id IN (${idList}) AND reason_detail IS NOT NULL`,
      ),
    },
    {
      table: "webhook_deliveries",
      // Both PII-bearing columns, not just the payload (#1205). `last_response`
      // holds up to 1000 chars of the subscriber's response body, and an error
      // response commonly quotes the request that caused it, so it carries the
      // person's name, email and phone (docs/pii-retention.md: "may echo PII").
      //
      // It needs checking HERE specifically because it cannot self-heal: blanking
      // it in Supabase sets payload_erased, which is exactly what freezes the row
      // from re-export (applySkipRedacted) so the mirror cannot clobber a
      // redaction. The Supabase null therefore never propagates, and only the
      // runbook's manual purge clears the warehouse copy. Checking the payload
      // alone made this audit report "clean" on a row that still held contact
      // data, which is worse than no check.
      residual: await countSnowflake(
        config,
        `SELECT count(*) FROM webhook_deliveries WHERE payload:booking_id::string IN (${idList}) AND (payload:attendee:email IS NOT NULL OR last_response IS NOT NULL)`,
      ),
    },
    {
      table: "booking_outbox",
      // The two ERROR-BEARING fields and not the payload, and the asymmetry is the
      // point.
      //
      // The payload is out of erasure scope: it carries a reason code, staff-typed
      // free text, timestamps and internal user ids, and incidental mentions in
      // staff free text are not treated as PII requiring erasure (#1199). Counting
      // it would alert on healthy rows forever.
      //
      // This said `last_error` ONLY until #1207, which is what let the identical
      // text inside `steps[].error` sit in the warehouse unmeasured while this
      // lane reported clean.
      //
      // `last_error` is in scope because it is `err.message` from whatever a step
      // threw (src/lib/booking/outbox.ts), and two steps are OUTBOUND calls (a
      // Google Calendar delete and a notify), so the text is the external
      // service's. A calendar API error can quote an attendee's email back at us,
      // and we cannot enumerate what a third party writes into an error string, so
      // it is treated as possibly carrying contact data.
      //
      // Neither can self-heal reliably. `booking_outbox` is deliberately absent
      // from applySkipRedacted, so a row STILL PRESENT in Supabase does re-export
      // and overwrite the warehouse copy. But outbox retention is a hard DELETE,
      // so once the row has aged out nothing remains to MERGE and only the purge
      // clears it (the runbook says exactly this under "Never wait for the export
      // to fix a booking_outbox residual"). This is the sole unattended check that
      // an operator ran that statement.
      residual: await countSnowflake(
        config,
        `SELECT count(*) FROM booking_outbox WHERE booking_id IN (${idList}) ` +
          `AND (last_error IS NOT NULL ` +
          // `steps[].error` is the same `err.message` as `last_error`, so it carries
          // the same risk (#1207). Judged on the TEXT, cast to string, rather than on
          // whether the key is present: the purge REMOVES the key (object_insert with
          // null) while a Supabase erasure that re-exports leaves it as a JSON null,
          // and a check that read presence would page forever on a row that already
          // healed itself. Measured against the live warehouse 2026-08-31: a real
          // error counts 1, and both cleared shapes count 0.
          `OR array_size(filter(steps, s variant -> coalesce(s:error::string, '') <> '')) > 0)`,
      ),
    },
  ];
}

/** The shape both sides of the split share, so neither can forget a field. */
const NOTHING: Pick<
  ErasureAuditOutcome,
  "residuals" | "reasons" | "realBookingIds" | "testResiduals" | "testReasons" | "testBookingIds" | "classificationUnreadable"
> = {
  residuals: [],
  reasons: [],
  realBookingIds: [],
  testResiduals: [],
  testReasons: [],
  testBookingIds: [],
  classificationUnreadable: null,
};

export async function auditSnowflakeErasures(): Promise<ErasureAuditOutcome> {
  const config = readSnowflakeConfig();
  if (!config) return { skipped: true, ok: true, erasedBookings: 0, ...NOTHING };

  // Every erased booking id, from the pii.erasure audit trail. Read through the
  // shared trail reader (#1128) so this lane and the purge that clears what it
  // finds can never disagree about which bookings are in scope.
  const ids = new Set(erasedIdsFrom(await readErasureAuditRows()));
  if (ids.size === 0) return { ok: true, erasedBookings: 0, ...NOTHING };

  // #1196: ask the warehouse about the two classes SEPARATELY, so a synthetic
  // fixture's residual can never be counted into the page a real erasure raises.
  // A class that could not be read lands on real (classifyErasedBookings), so the
  // worst case is a real page about a test booking, never the reverse.
  const classes = classifyErasedBookings([...ids], await readBookingClasses([...ids]));

  const residuals = classes.realIds.length > 0
    ? await residualsForBookingIds(config, classes.realIds)
    : [];
  const testResiduals = classes.testIds.length > 0
    ? await residualsForBookingIds(config, classes.testIds)
    : [];

  const { ok, reasons } = evaluateErasureAudit(residuals);
  const test = evaluateErasureAudit(testResiduals);
  log.info("erasure-audit", {
    msg: ok ? "clean" : "residual PII",
    erased: ids.size,
    real: classes.realIds.length,
    test: classes.testIds.length,
    flagged: reasons.length,
    test_flagged: test.reasons.length,
    unclassified: classes.unreadable ?? "none",
  });
  return {
    ok,
    erasedBookings: ids.size,
    residuals,
    reasons,
    realBookingIds: classes.realIds,
    testResiduals,
    testReasons: test.reasons,
    testBookingIds: classes.testIds,
    classificationUnreadable: classes.unreadable,
  };
}
