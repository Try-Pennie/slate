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
import { erasedIdsFrom, readErasureAuditRows } from "./erasure-trail";
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

export interface ErasureAuditOutcome {
  skipped?: true;
  ok: boolean;
  erasedBookings: number;
  residuals: ErasureResidual[];
  reasons: string[];
}

async function countSnowflake(config: SnowflakeConfig, sql: string): Promise<number> {
  const res = await executeStatement(config, sql);
  return Number(res.data?.[0]?.[0] ?? 0);
}

export async function auditSnowflakeErasures(): Promise<ErasureAuditOutcome> {
  const config = readSnowflakeConfig();
  if (!config) return { skipped: true, ok: true, erasedBookings: 0, residuals: [], reasons: [] };

  // Every erased booking id, from the pii.erasure audit trail. Read through the
  // shared trail reader (#1128) so this lane and the purge that clears what it
  // finds can never disagree about which bookings are in scope.
  const ids = new Set(erasedIdsFrom(await readErasureAuditRows()));
  if (ids.size === 0) return { ok: true, erasedBookings: 0, residuals: [], reasons: [] };

  // `ids` come from our own audit rows (uuids), never user input; still escape
  // them defensively before interpolating into the Snowflake statement.
  const idList = [...ids].map((id) => `'${escapeSqlLiteral(id)}'`).join(",");
  const residuals: ErasureResidual[] = [
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
      // `last_error` ONLY, deliberately, and the asymmetry is the point.
      //
      // The payload is out of erasure scope: it carries a reason code, staff-typed
      // free text, timestamps and internal user ids, and incidental mentions in
      // staff free text are not treated as PII requiring erasure (#1199). Counting
      // it would alert on healthy rows forever.
      //
      // `last_error` is in scope because it is `err.message` from whatever a step
      // threw (src/lib/booking/outbox.ts), and two steps are OUTBOUND calls (a
      // Google Calendar delete and a notify), so the text is the external
      // service's. A calendar API error can quote an attendee's email back at us,
      // and we cannot enumerate what a third party writes into an error string, so
      // it is treated as possibly carrying contact data.
      //
      // It cannot self-heal either: outbox retention is a hard DELETE in Supabase,
      // so once the row is gone nothing remains to MERGE over the warehouse copy,
      // and only the runbook's manual purge clears it. This is the sole unattended
      // check that an operator ran that statement.
      residual: await countSnowflake(
        config,
        `SELECT count(*) FROM booking_outbox WHERE booking_id IN (${idList}) AND last_error IS NOT NULL`,
      ),
    },
  ];

  const { ok, reasons } = evaluateErasureAudit(residuals);
  log.info("erasure-audit", { msg: ok ? "clean" : "residual PII", erased: ids.size, flagged: reasons.length });
  return { ok, erasedBookings: ids.size, residuals, reasons };
}
