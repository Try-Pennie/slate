/**
 * The pure half of the Snowflake mirror reconciliation (#1101), lifted out in
 * #1230.
 *
 * It imports only `export-lag-core.ts` (which itself imports nothing), so the
 * alert preview and the node suite can load it without touching Supabase. That
 * matters because the per-table drift reason is COPY: it is the sentence someone
 * reads on a phone at 7am, and `pnpm preview:alerts` has to render the real one
 * rather than a retyped lookalike (L41). The IO half lives in reconcile.ts.
 */

// The `@/` alias, not a relative path: this module is loaded directly by node
// (the alert preview and its coverage guard), whose resolver needs the alias hook
// in scripts/path-alias-hooks.mjs to find an extensionless TS import.
import { MAX_EXPORT_LAG_MS, formatLag, type TableLag } from "@/lib/snowflake/export-lag-core";

// Normal lag tolerance: the export runs every 30 min, so Supabase can legitimately
// be a little ahead of Snowflake. Alert only when the gap exceeds the larger of a
// flat floor and a small fraction of the table, so a genuinely stuck lane shows
// but ordinary between-tick lag does not.
export const DRIFT_TOLERANCE_ROWS = 25;
export const DRIFT_TOLERANCE_PCT = 0.02;

export function reconThreshold(supabaseRows: number): number {
  return Math.max(DRIFT_TOLERANCE_ROWS, Math.ceil(supabaseRows * DRIFT_TOLERANCE_PCT));
}

export interface TableRecon {
  table: string;
  supabase: number;
  snowflake: number;
  /** Supabase minus Snowflake: positive = Snowflake is behind. */
  drift: number;
  /**
   * Exportable rows strictly BEHIND the export cursor (#1231), or null when the
   * table has no cursor yet, in which case no row can be behind one.
   *
   * Never 0 to mean "the read failed": a failed count throws, because a zero here
   * is indistinguishable from a healthy mirror.
   */
  behindCursor: number | null;
}

export interface ControlCheck {
  table: string;
  id: string;
  foundInSnowflake: boolean;
}

export interface ReconOutcome {
  skipped?: true;
  ok: boolean;
  tables: TableRecon[];
  controls: ControlCheck[];
  reasons: string[];
}

/**
 * Which of the two causes of drift the lag reading actually measured (#1230).
 *
 * A count gap has exactly two explanations, and they need opposite responses:
 * the export lane is behind (it will clear itself), or the rows sit behind the
 * lane's strictly forward keyset watermark and it will never revisit them (they
 * need a repair). The lane's own position, measured in Supabase for the deletion
 * gate, tells the two apart, so the reason says which one it saw instead of
 * guessing. On 2026-08-03 the guess was wrong: the lane was on the newest row
 * and the 251 missing rows were an OOO audit backfill inserted behind it.
 *
 * An UNMEASURED lane is its own answer. A missing or unreadable reading must
 * present as unknown, never as a current lane, because "current" is what licenses
 * the strongest claim here (these rows will never export on their own).
 */
export function driftCause(drift: number, lag: TableLag | undefined): string {
  if (!lag || Number.isNaN(lag.lagMs)) {
    return (
      "the export lane's own position could not be read, so whether the lane is behind " +
      "or these rows sit behind its watermark is unknown"
    );
  }
  if (lag.cursorTs === null) {
    return "nothing has ever been exported for this table, so the export lane has not started";
  }
  if (lag.lagMs > MAX_EXPORT_LAG_MS) {
    return (
      `the oldest row waiting for export is ${formatLag(lag.lagMs)} old, with ${lag.backlog} rows waiting to ` +
      `export, so this clears itself once the lane catches up`
    );
  }
  // The lane is within the tolerance the deletion gate uses, so anything missing
  // beyond what is still queued cannot be explained by lag.
  const stranded = drift - lag.backlog;
  if (stranded <= 0) {
    return (
      `the export lane is current (its oldest waiting row is ${formatLag(lag.lagMs)} old) with ${lag.backlog} rows ` +
      `waiting, so this should clear on the next export tick`
    );
  }
  // The one claim here strong enough to need a remedy attached: nothing in the
  // system will fix this on its own. The remedy rides with the cause rather than
  // sitting in the alert wrapper, because the wrapper also carries a failed
  // positive control, where re-exporting is the wrong advice (L36).
  return (
    `the export lane is current (its oldest waiting row is ${formatLag(lag.lagMs)} old, ${lag.backlog} rows waiting), ` +
    `so ${stranded} of these rows sit behind its strictly forward watermark and will never export on their own ` +
    `until they are re-exported (src/lib/snowflake/reexport.ts)`
  );
}

/** Pure decision: given per-table counts, the controls, and each table's measured
 *  export lag, what (if anything) is wrong. `lags` may be empty: an unmeasured
 *  lane reads as an unknown cause, not a healthy one. */
export function evaluateRecon(
  tables: TableRecon[],
  controls: ControlCheck[],
  lags: TableLag[] = [],
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const control of controls) {
    if (control.foundInSnowflake) continue;
    reasons.push(
      `positive control failed: ${control.table} row ${control.id} is in Supabase but not found in Snowflake, so the count reads cannot be trusted (a zero may be a broken query, not an empty table)`,
    );
  }
  for (const t of tables) {
    // The EXACT reading first (#1231), and it is authoritative: a row strictly
    // behind the cursor was already walked past, so the warehouse should hold it.
    // Every legitimate difference goes the other way (rows AT the cursor, rows
    // retention later deleted from Supabase, redacted rows the warehouse still
    // holds), which is why this needs no tolerance and can see a single stranded
    // row where the total-count comparison below needs 25 or 2%.
    //
    // Two facts this rests on, both worth rechecking before changing it: the
    // cursor advances ONLY after a confirmed terminal MERGE (#1099), so a row
    // behind it was demonstrably written; and nothing ever DELETEs from the
    // warehouse (the erasure purge updates in place, purge-sql.ts), so its count
    // cannot shrink and make this fire spuriously.
    //
    // "At least", because a warehouse holding those legitimate extras understates
    // the gap. The count is a floor, and the reason says so.
    if (t.behindCursor !== null && t.behindCursor > t.snowflake) {
      const missing = t.behindCursor - t.snowflake;
      reasons.push(
        `${t.table}: at least ${missing} ${missing === 1 ? "row that sits" : "rows that sit"} behind the export ` +
          `watermark ${missing === 1 ? "is" : "are"} missing from the warehouse (${t.behindCursor} rows sit ` +
          `behind the cursor, ${t.snowflake} are in Snowflake), so ${missing === 1 ? "it was" : "they were"} ` +
          `written behind the cursor and will never export on ${missing === 1 ? "its" : "their"} own until ` +
          `re-exported (src/lib/snowflake/reexport.ts)`,
      );
      continue; // one missing-rows reason per table: a count beats an estimate
    }
    // Only "Snowflake is BEHIND" is a fault (the mirror is losing/lagging rows).
    // "Snowflake ahead" (more rows than Supabase) is EXPECTED once export-gated
    // retention (#1102) prunes aged rows from Supabase while the warehouse keeps
    // the full history, so it is deliberately NOT flagged.
    if (t.drift > reconThreshold(t.supabase)) {
      const cause = driftCause(t.drift, lags.find((l) => l.table === t.table));
      reasons.push(`${t.table}: Snowflake is behind by ${t.drift} rows (${t.snowflake}/${t.supabase}) and ${cause}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
