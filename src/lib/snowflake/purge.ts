/**
 * Running the warehouse half of a data-subject erasure, and proving it still runs
 * (#1128).
 *
 * Two entry points over the one canonical SQL in `purge-sql.ts`:
 *
 *   - `probeErasurePurgeSql` executes every statement against the real warehouse
 *     bound to an id that cannot match a row. It changes nothing and proves the
 *     SQL still compiles and resolves against the live schema, which is exactly
 *     the failure #1197 was: a statement naming a Supabase-only column, rejected
 *     outright, so the payloads were never purged while the verify still said
 *     zero. The lane runs it every 6 hours, so the answer is never older than
 *     that rather than being a claim from the day someone last read the runbook.
 *
 *   - `purgeSnowflakeErasure` actually clears the warehouse, scoped to booking
 *     ids that already appear in a `pii.erasure` audit row. That scope is the
 *     whole safety argument: a booking in that trail has ALREADY had its contact
 *     data erased in Supabase, so blanking the warehouse copy is by definition
 *     the outcome that was requested, and an id outside the trail is refused
 *     rather than purged.
 *
 * On the credential: the export role is append-only in the sense that matters
 * (`docs/snowflake-setup.sql` withholds DELETE and TRUNCATE), but it does hold
 * UPDATE, which is what the export's MERGE needs. Redact-in-place is an UPDATE,
 * so no extra credential is required for either function here. Nothing in this
 * module can delete a warehouse row.
 */

import { log } from "@/lib/log";
import { recordAudit } from "@/lib/audit";
import { shortErrorReason } from "@/lib/notify/error-text";
import { readSnowflakeConfig } from "./config";
import { executeStatement, type SnowflakeConfig, type SnowflakeStatementResponse } from "./client";
import { erasedIdsFrom, readErasureAuditRows } from "./erasure-trail";
import {
  VERIFY_COLUMNS,
  buildProbeStatements,
  buildPurgeStatements,
  buildVerifyStatement,
  statementLabel,
} from "./purge-sql";

/**
 * Read a numeric cell out of a Snowflake answer, or null when it cannot be read.
 *
 * Null is deliberately NOT collapsed to 0 by any caller here. A `Number()` on a
 * missing cell yields NaN, every comparison with NaN is false, and the check
 * would land on the healthy side reporting "no rows changed" or "no residual"
 * having measured nothing at all.
 */
function readNumber(res: SnowflakeStatementResponse, index = 0): number | null {
  const cell = res.data?.[0]?.[index];
  if (cell === undefined || cell === null) return null;
  const n = Number(cell);
  return Number.isFinite(n) ? n : null;
}

export interface ProbeStatementResult {
  /** The mirror table this statement writes, or "verify". */
  label: string;
  ok: boolean;
  /** Rows the statement changed. Must be 0. Null when it could not be read. */
  rows: number | null;
}

export interface PurgeSqlProbeOutcome {
  ok: boolean;
  statements: ProbeStatementResult[];
  reasons: string[];
}

/**
 * Execute every erasure purge statement against the warehouse, bound to the
 * sentinel id, and require each one to compile and change nothing.
 *
 * Every statement is attempted even after one fails, so a single page lists
 * everything that is broken instead of only the first thing.
 *
 * What this proves, exactly: the SQL an operator would paste still parses and
 * resolves against the warehouse as it exists right now. What it cannot prove: a
 * zero-row statement can only ever report zero rows, so it says nothing about
 * whether the statements clear fields on a real row. The runbook says the same,
 * because a check may claim only what it measured.
 */
export async function probeErasurePurgeSql(config: SnowflakeConfig): Promise<PurgeSqlProbeOutcome> {
  const statements = buildProbeStatements();
  const results: ProbeStatementResult[] = [];
  const reasons: string[] = [];

  for (const sql of statements) {
    const label = statementLabel(sql);
    const isVerify = label === "verify";
    try {
      const res = await executeStatement(config, sql);
      if (isVerify) {
        // The verify is a read, so "changed nothing" is meaningless for it; what
        // matters is that it returned its four counts and they are all zero for
        // an id no row can carry.
        const counts = VERIFY_COLUMNS.map((_, i) => readNumber(res, i));
        if (counts.some((c) => c === null)) {
          reasons.push("verify: could not read the residual counts Snowflake returned, so it is unproven");
          results.push({ label, ok: false, rows: null });
          continue;
        }
        const nonZero = counts.reduce<number>((sum, c) => sum + (c ?? 0), 0);
        if (nonZero !== 0) {
          reasons.push(`verify: counted ${nonZero} row(s) for an id no booking can have`);
          results.push({ label, ok: false, rows: nonZero });
          continue;
        }
        results.push({ label, ok: true, rows: 0 });
        continue;
      }

      const rows = readNumber(res);
      if (rows === null) {
        reasons.push(`${label}: could not read the row count Snowflake returned, so this statement is unproven`);
        results.push({ label, ok: false, rows: null });
      } else if (rows !== 0) {
        // Structurally impossible (the sentinel is not uuid-shaped), so if it
        // happens the assumption that makes this probe safe is wrong.
        reasons.push(`${label}: changed ${rows} row(s) for an id no booking can have`);
        results.push({ label, ok: false, rows });
      } else {
        results.push({ label, ok: true, rows: 0 });
      }
    } catch (err) {
      log.error("erasure-purge-probe", { msg: "statement failed", statement: label }, err);
      // alert-text-ok: shortErrorReason collapses Snowflake's multi-line SQL
      // compilation error to one human line; the full text is in the log above.
      reasons.push(`${label}: the statement no longer runs (${shortErrorReason(err)})`);
      results.push({ label, ok: false, rows: null });
    }
  }

  const ok = reasons.length === 0;
  log.info("erasure-purge-probe", { msg: ok ? "sql ok" : "sql broken", broken: reasons.length });
  return { ok, statements: results, reasons };
}

/**
 * The lane's entry point: read the config, then probe. Returns `skipped` while the
 * mirror is unconfigured, so a Slate without Snowflake neither probes nor claims
 * anything, and in particular never clears a page it did not measure.
 */
export async function runErasurePurgeSqlProbe(): Promise<PurgeSqlProbeOutcome & { skipped?: true }> {
  const config = readSnowflakeConfig();
  if (!config) return { skipped: true, ok: true, statements: [], reasons: [] };
  return probeErasurePurgeSql(config);
}

export interface PurgeOutcome {
  skipped?: true;
  /** True only when the verify afterwards measured zero residual everywhere. */
  ok: boolean;
  bookingIds: string[];
  rowsByTable: Record<string, number>;
  residualAfter: Record<string, number | null>;
  reasons: string[];
}

/**
 * Clear the warehouse copy of the contact data for erased bookings, then verify.
 *
 * `ids` defaults to every booking in the erasure trail (re-running is harmless:
 * the statements are idempotent, a second run changes zero rows). An explicit
 * list is intersected with the trail, and an id outside it THROWS rather than
 * being quietly dropped, so a typo cannot silently purge the wrong set or read as
 * a successful purge of nothing.
 *
 * Fails loud throughout: a statement error propagates and no audit row is
 * written, because a record saying the warehouse was purged is worse than no
 * record when it was not.
 */
export async function purgeSnowflakeErasure(ids?: string[], actorId?: string): Promise<PurgeOutcome> {
  const config = readSnowflakeConfig();
  if (!config) {
    return { skipped: true, ok: true, bookingIds: [], rowsByTable: {}, residualAfter: {}, reasons: [] };
  }

  // Throws on a read error (selectAllPages), which is what keeps an unreadable
  // trail from presenting as "nothing to purge".
  const rows = await readErasureAuditRows();
  const erased = erasedIdsFrom(rows);

  let target: string[];
  if (ids === undefined) {
    target = erased;
  } else {
    const unknown = ids.filter((id) => !erased.includes(id));
    if (unknown.length > 0) {
      throw new Error(
        `erasure purge: ${unknown.length} booking id(s) have not been erased in Supabase, so their ` +
          `warehouse copy must not be blanked: ${unknown.join(", ")}`,
      );
    }
    target = ids;
  }

  if (target.length === 0) {
    log.info("erasure-purge", { msg: "no erased bookings to purge" });
    return { ok: true, bookingIds: [], rowsByTable: {}, residualAfter: {}, reasons: [] };
  }

  const rowsByTable: Record<string, number> = {};
  for (const sql of buildPurgeStatements(target)) {
    const label = statementLabel(sql);
    const res = await executeStatement(config, sql);
    const changed = readNumber(res);
    if (changed === null) {
      throw new Error(`erasure purge: ${label} ran but Snowflake's row count could not be read`);
    }
    rowsByTable[label] = changed;
  }

  const verify = await executeStatement(config, buildVerifyStatement(target));
  const residualAfter: Record<string, number | null> = {};
  const reasons: string[] = [];
  VERIFY_COLUMNS.forEach((col, i) => {
    const count = readNumber(verify, i);
    residualAfter[col.table] = count;
    if (count === null) {
      reasons.push(`${col.table}: could not read the residual count, so the purge is unverified`);
    } else if (count > 0) {
      reasons.push(`${col.table}: ${count} row(s) still hold contact PII after the purge`);
    }
  });

  const ok = reasons.length === 0;
  log.info("erasure-purge", {
    msg: ok ? "purged and verified" : "purge left a residual",
    bookings: target.length,
    ...rowsByTable,
  });

  await recordAudit({
    orgId: rows[0]?.org_id ?? "",
    actorId: actorId ?? null,
    action: "pii.warehouse_purge",
    details: {
      booking_ids: target,
      rows_by_table: rowsByTable,
      residual_after: residualAfter,
      verified: ok,
    },
  });

  return { ok, bookingIds: target, rowsByTable, residualAfter, reasons };
}
