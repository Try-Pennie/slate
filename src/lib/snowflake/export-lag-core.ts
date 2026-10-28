/**
 * The pure half of the export-lag deletion gate (#1139).
 *
 * This module imports only the pure stamp parser, so the node test suite can
 * drive it directly (same reason as export-core.ts). The IO half lives in
 * export-lag.ts.
 *
 * WHY THIS REPLACED THE ROW-COUNT RECONCILIATION AS THE GATE
 *
 * Until now every retention lane was gated on `reconcileSnowflakeMirror`, which
 * counts each mirrored table in Supabase and in Snowflake and flags only
 * positive drift (Supabase ahead). That comparison stops being a safety signal
 * the moment anything is removed from Supabase:
 *
 *   - Hard-deleting pruned rows makes `supabase - snowflake` structurally
 *     negative for routing_decisions and booking_outbox, so a genuinely lagging
 *     export lane can no longer show up there.
 *   - For bookings and webhook_deliveries the same thing happens from in-place
 *     redaction alone, because the Supabase count applies the skip-redacted
 *     predicate while the Snowflake count sees every warehouse row.
 *
 * Net effect: the outer gate degraded to a rubber stamp exactly when deletion
 * began. This reading is computed entirely in Supabase, so it is immune to both
 * pruning and redaction, costs zero warehouse reads and zero warehouse resumes,
 * and is testable with a fake.
 *
 * WHAT IT DOES AND DOES NOT PROVE
 *
 * It proves the export lane is keeping up: that the cursor has advanced to
 * roughly the newest row each mirrored table holds. It does NOT ask the
 * warehouse anything, so it cannot see a row Snowflake has quietly lost. Two
 * other controls cover that, and neither was removed:
 *
 *   - the per-row read-back (`destroyVerified`, #1132), which is the real gate
 *     on every individual delete and asks the warehouse by id;
 *   - the row-count reconciliation, which keeps running on its own 6-hourly lane
 *     as an independent drift monitor.
 *
 * KNOWN BLIND SPOT. A row committed with a watermark EARLIER than the cursor
 * (booking_outbox has no set_updated_at trigger, and its writers stamp
 * updated_at from the Worker's own clock) is never exported by the strictly
 * forward keyset fetch and is invisible here: it is neither backlog nor lag.
 * That row is caught at delete time by the per-row read-back, which is where
 * docs/pii-retention.md section 7b already says the real control lives.
 */

import { parseStampMs } from "@/lib/date/stamp";

/**
 * How old the oldest row still waiting for export may be before a delete is
 * refused.
 *
 * The export lane runs every 30 minutes (#4349), so on a healthy mirror no row
 * waits more than about half an hour. Two hours is four consecutive missed ticks
 * (it was one hour, six ticks, at the old 10 minute cadence): comfortably past
 * ordinary between-tick waiting and a slow catch-up, well short of the daily
 * cadence of the lanes this gates, so a single hiccup does not stop retention
 * for a day. That is the quantity `exportLagAgeMs` computes (#1713): it used to
 * be compared against the gap between the two newest rows, which on a sparse
 * table is the table's own arrival rhythm and is unbounded above however
 * healthy the lane is.
 */
export const MAX_EXPORT_LAG_MS = 2 * 60 * 60_000;

export interface TableLag {
  table: string;
  /** Export cursor position, or null when nothing has ever been exported. */
  cursorTs: string | null;
  /** Newest watermark among exportable rows, or null when the table is empty. */
  newestTs: string | null;
  /**
   * Oldest exportable watermark strictly past the cursor, or null when nothing
   * is waiting. Not read when there is no cursor (the lag is Infinity anyway).
   */
  oldestPendingTs: string | null;
  /**
   * How long the oldest waiting row has been waiting, in ms: the clock at
   * measurement minus oldestPendingTs, floored at 0. Zero when nothing waits.
   * Infinity when rows exist and nothing has been exported. NaN when a stamp
   * could not be read, which MUST be treated as a fault rather than compared
   * against the bound.
   */
  lagMs: number;
  /** Rows past the cursor awaiting export. Diagnostic, not a threshold. */
  backlog: number;
}

/**
 * The lag reading itself (#1713): how long the oldest row still waiting for
 * export has been waiting, measured against the CLOCK the lane read at.
 *
 * Why the clock and not the newest row. `newest - cursor` reads zero while
 * everything is exported, and the moment one row lands it reads the interval
 * between that row and the one before it, which is how often the table is
 * written to, not how long anything has waited. On 2026-09-02 a time off request
 * written at 02:53:14, with the previous audit row at 00:11:36, scored "3 hours
 * behind" at 03:00:04 while being under seven minutes old, and all three PII
 * retention lanes refused for the night (L537). The age of the oldest waiting
 * row is what the bound above was always reasoned about in terms of.
 *
 * Every uncertain input lands on the fail-safe side:
 *   - no rows at all: 0, because an empty table cannot be behind and must not
 *     freeze the other lanes;
 *   - rows but no cursor: Infinity, because NOTHING is in the warehouse yet;
 *   - nothing past the cursor: 0, the lane is current;
 *   - a stamp or a clock that will not read: NaN, which the evaluator refuses.
 *     Routed through parseStampMs rather than Date.parse so a bad value cannot
 *     silently compare false against the bound and read as healthy (#1169/#1171);
 *   - a waiting row stamped AFTER the clock (skew between the writer's clock and
 *     the reader's): 0 rather than negative.
 */
export function exportLagAgeMs(reading: {
  cursorTs: string | null;
  newestTs: string | null;
  oldestPendingTs: string | null;
  nowMs: number;
}): number {
  if (reading.newestTs === null) return 0;
  if (reading.cursorTs === null) return Number.POSITIVE_INFINITY;
  if (reading.oldestPendingTs === null) return 0;
  const oldest = parseStampMs(reading.oldestPendingTs);
  if (oldest === null || !Number.isFinite(reading.nowMs)) return Number.NaN;
  return Math.max(0, reading.nowMs - oldest);
}

export interface LagGate {
  ready: boolean;
  reasons: string[];
}

/**
 * Decide whether the mirror is current enough to permit a delete.
 *
 * Gating is on lag alone, deliberately. Backlog size is volume-dependent (a
 * burst of bookings is not a fault), and a lane that genuinely cannot keep up
 * shows up as growing lag anyway, since the cursor falls further behind the
 * newest row every tick. Backlog is reported so an alert can say how much is
 * waiting, never used as a threshold.
 *
 * Every uncertain reading lands on NOT ready. An unreadable timestamp is the
 * #1169/#1171 class: NaN compares false against every threshold, so a naive
 * `lagMs > MAX` check would silently land on "not lagging" and permit the
 * delete. It is checked explicitly here instead.
 */
export function evaluateExportLag(tables: TableLag[]): LagGate {
  const reasons: string[] = [];

  // An empty reading means the measurement did not happen, which is not the
  // same as a healthy mirror. Absence is never proof of health.
  if (tables.length === 0) {
    return { ready: false, reasons: ["no mirrored tables were measured, so the export lag could not be judged"] };
  }

  for (const t of tables) {
    if (Number.isNaN(t.lagMs)) {
      reasons.push(`${t.table}: could not read the export lag (an unreadable timestamp), so the mirror is unproven`);
      continue;
    }
    if (t.cursorTs === null && t.newestTs !== null) {
      reasons.push(`${t.table}: nothing exported yet, and ${t.backlog} rows are waiting`);
      continue;
    }
    if (t.lagMs > MAX_EXPORT_LAG_MS) {
      reasons.push(
        `${t.table}: the oldest row waiting for export is ${formatLag(t.lagMs)} old, with ${t.backlog} rows waiting`,
      );
    }
  }

  return { ready: reasons.length === 0, reasons };
}

/** Whole-minute or whole-hour age, for a reader holding a phone mid-incident. */
export function formatLag(ms: number): string {
  if (!Number.isFinite(ms)) return "indefinitely";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
