/**
 * Erasure content audit for the Snowflake mirror (#1103, Workstream C).
 *
 * The Snowflake half of a DSR erasure is an operator-run MANUAL step (the export
 * role is append-only by design). Nothing forces the operator to actually do it,
 * and the count reconcile (#1101) is structurally blind to it: a redacted-in-place
 * row and a full-fidelity one have the SAME row count, so a warehouse that still
 * holds an erased person's PII reconciles as perfectly in sync.
 *
 * This lane is the detective control that closes that gap. For every booking id
 * recorded in a `pii.erasure` audit entry, it asserts Snowflake holds NO residual
 * contact PII, and the cron route alerts loudly if it does. The Worker's export
 * role can READ Snowflake (reads are allowed by design), so this needs no extra
 * credential; it only surfaces an incomplete operator purge, it cannot fix it.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { log } from "@/lib/log";
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

  const db = supabaseAdmin();
  // Every erased booking id, from the pii.erasure audit trail. Paginated because
  // audit_log is a growth table (the .range in the page callback bounds each read).
  const rows = await selectAllPages<{ details: { booking_ids?: string[] } | null }>(
    "erasure-audit ids",
    (from, to) =>
      db
        .from("audit_log")
        .select("details")
        .eq("action", "pii.erasure")
        .range(from, to) as unknown as PromiseLike<{ data: unknown[] | null; error?: { message: string } | null }>,
  );
  const ids = new Set<string>();
  for (const r of rows) for (const id of r.details?.booking_ids ?? []) ids.add(id);
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
      residual: await countSnowflake(
        config,
        `SELECT count(*) FROM webhook_deliveries WHERE payload:booking_id::string IN (${idList}) AND payload:attendee:email IS NOT NULL`,
      ),
    },
  ];

  const { ok, reasons } = evaluateErasureAudit(residuals);
  log.info("erasure-audit", { msg: ok ? "clean" : "residual PII", erased: ids.size, flagged: reasons.length });
  return { ok, erasedBookings: ids.size, residuals, reasons };
}
