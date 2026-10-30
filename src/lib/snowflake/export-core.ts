/**
 * Pure export orchestration for the Snowflake mirror lane (#1099).
 *
 * This module has NO runtime imports (only a type-only ColSpec), so the node
 * test suite can drive it with hand-written fakes. The DB + Snowflake wiring
 * lives in export.ts; the resumable-watermark loop lives here.
 *
 * The one correctness invariant, exercised by scripts/test-snowflake-export.ts:
 * the cursor advances ONLY after mergeBatch resolves (a confirmed terminal
 * Snowflake response). If mergeBatch throws, the exception propagates and the
 * cursor is left where it was, so the batch re-exports next tick. Because the
 * MERGE is keyed by id, re-exporting a batch is idempotent.
 */

import type { ColSpec } from "./merge";

/** How much wall-clock one export tick may spend before it stops and resumes
 *  next run. A soft, self-imposed deadline well under the platform ceiling. */
export const WALL_TIME_BUDGET_MS = 60_000;

/** Rows per batch. Well under PostgREST's 1000-row page cap and a reasonable
 *  MERGE VALUES size. */
export const DEFAULT_BATCH = 500;

/**
 * The warehouse load-stamp column every mirror table carries (#1116). Written by
 * the MERGE on both branches, never sourced from Supabase, so it records when the
 * warehouse last saw the row. Declared here rather than in merge.ts because this
 * module owns the mirror contract and, having no runtime imports, is reachable
 * from the node test suite.
 */
export const LOAD_STAMP_COL = "exported_at";

export interface TableSpec {
  /** Table name, identical in Supabase and Snowflake. */
  table: string;
  /** The ordering/watermark column: updated_at for mutable tables (re-exports a
   *  row when it changes), created_at for append-only tables. */
  watermark: "created_at" | "updated_at";
  /** Snowflake columns, in order, for the MERGE. */
  cols: ColSpec[];
}

const v = (name: string): ColSpec => ({ name, type: "varchar" });
const ts = (name: string): ColSpec => ({ name, type: "timestamp_tz" });
const n = (name: string): ColSpec => ({ name, type: "number" });
const b = (name: string): ColSpec => ({ name, type: "boolean" });
const json = (name: string): ColSpec => ({ name, type: "variant" });

/** The six mirrored tables, their watermark column, and their Snowflake columns
 *  in order. Column names + types must match docs/snowflake-setup.sql. */
export const MIRROR_TABLES: TableSpec[] = [
  {
    table: "bookings",
    watermark: "updated_at",
    cols: [
      v("id"), v("org_id"), v("bucket_id"), v("event_type_id"), v("assigned_user_id"),
      v("agent_name"), v("agent_email"), ts("starts_at"), ts("ends_at"), ts("original_starts_at"),
      ts("original_ends_at"), v("timezone"), v("status"), v("salesforce_id"), v("attendee_name"),
      v("attendee_email"), v("attendee_phone"), json("prefill"), v("gcal_event_id"), v("manage_token"),
      v("idempotency_key"), v("external_id"), json("routing_trace"), b("allow_double_book"),
      n("reschedule_seq"), ts("created_at"), ts("updated_at"),
      // #2072: the page the lead booked from. Added after the table was
      // provisioned, so the warehouse gets it from the self-heal ALTER in
      // docs/snowflake-setup.sql, which must run BEFORE this deploys or every
      // bookings MERGE fails on an unknown column.
      v("source"),
      // #2772: the origin of the page that framed the booker (#2728), judged beside
      // prefill.parentOrigin. Same rule as source: its ALTER in
      // docs/snowflake-setup.sql runs in Snowsight BEFORE this deploys.
      v("referrer_origin"),
      // #2828: routed or agent_link (#2073, migration 0144), so warehouse analytics
      // can leave advisor link bookings out of anything about routing. Same rule as
      // source: its ALTER in docs/snowflake-setup.sql runs in Snowsight BEFORE this
      // deploys.
      v("kind"),
      // #4397: whether the booking came through the partner program (#4387, migration
      // 0213), so warehouse reports can tell program bookings from any other. Same rule
      // as source: its ALTER in docs/snowflake-setup.sql runs in Snowsight BEFORE this
      // deploys.
      b("program_lead"),
    ],
  },
  {
    table: "webhook_deliveries",
    watermark: "updated_at",
    cols: [
      v("id"), v("endpoint_id"), v("event"), json("payload"), v("status"), n("attempts"),
      v("last_response"), b("suppressed"), ts("created_at"), ts("updated_at"),
    ],
  },
  {
    table: "booking_outbox",
    watermark: "updated_at",
    cols: [
      v("id"), v("booking_id"), v("action"), v("status"), json("steps"), json("payload"),
      ts("lease_until"), n("attempts"), v("last_error"), ts("next_attempt_at"),
      ts("created_at"), ts("updated_at"),
    ],
  },
  {
    table: "booking_events",
    watermark: "created_at",
    cols: [
      v("id"), v("booking_id"), v("action"), v("initiator"), v("reason_code"), v("reason_detail"),
      ts("from_starts_at"), ts("to_starts_at"), v("from_agent_user_id"), v("to_agent_user_id"),
      v("actor_user_id"), v("acting_as_user_id"), n("lead_time_minutes"), n("reschedule_seq"),
      // #3261: the buckets a reroute moved the booking from and to (migration 0166).
      // The warehouse ALTER in docs/snowflake-setup.sql must have run before this
      // deploys, or every booking_events MERGE fails on an unknown column; #3261
      // records it running. Events already exported without them are re-sent once by
      // rewinding this table's cursor after the deploy (docs/migrations-runbook.md).
      v("from_bucket_id"), v("to_bucket_id"),
      ts("created_at"),
    ],
  },
  {
    table: "audit_log",
    watermark: "created_at",
    cols: [v("id"), v("org_id"), v("actor_id"), v("action"), v("target_id"), json("details"), ts("created_at")],
  },
  {
    table: "routing_decisions",
    watermark: "created_at",
    cols: [
      v("id"), v("org_id"), v("booking_id"), v("bucket_code"), v("bucket_id"), v("requested_tier"),
      v("booked_tier"), v("chosen_user_id"), json("considered"), json("excluded"),
      b("empty_pool_fallback"), b("tier_fallback"), n("rungs_dropped"), v("outcome"), ts("created_at"),
    ],
  },
];

export interface CursorPos {
  last_ts: string | null;
  last_id: string | null;
}

export type Row = Record<string, unknown>;

export interface ExportDeps {
  loadCursor(key: string): Promise<CursorPos | null>;
  /** A keyset page after `cursor`, ordered by (watermark, id) ascending. */
  fetchBatch(spec: TableSpec, cursor: CursorPos | null, limit: number): Promise<Row[]>;
  /** MERGE the rows into Snowflake. MUST reject unless a terminal success response
   *  was confirmed (never resolve on a still-running 202). */
  mergeBatch(spec: TableSpec, rows: Row[]): Promise<void>;
  saveCursor(key: string, lastTs: string, lastId: string): Promise<void>;
  now(): number;
}

export interface ExportTableResult {
  table: string;
  key: string;
  exported: number;
  batches: number;
  hitDeadline: boolean;
  /** The lane lock was lost before a merge (#3120), so the run must stop. */
  leaseLost?: boolean;
}

export interface ExportTableOpts {
  limit: number;
  /** Epoch ms; the loop stops before starting a batch once now() passes this. */
  deadline: number;
  /** Cursor-scope prefix so the backfill lane (#1100) never shares a watermark
   *  with the incremental lane. Empty for the incremental lane. */
  keyPrefix?: string;
  /**
   * Asked before each MERGE (#3120). False means another run now owns the lane: the
   * MERGE overwrites by id with no recency check, so a batch from this older run
   * could put a stale row version back over the newer run's, and it is not sent.
   */
  stillHeld?: () => Promise<boolean>;
}

export async function exportTable(spec: TableSpec, deps: ExportDeps, opts: ExportTableOpts): Promise<ExportTableResult> {
  const key = (opts.keyPrefix ?? "") + spec.table;
  let cursor = await deps.loadCursor(key);
  let exported = 0;
  let batches = 0;
  let hitDeadline = false;

  for (;;) {
    if (deps.now() >= opts.deadline) {
      hitDeadline = true;
      break;
    }

    const rows = await deps.fetchBatch(spec, cursor, opts.limit);
    if (rows.length === 0) break;

    if (opts.stillHeld && !(await opts.stillHeld())) {
      return { table: spec.table, key, exported, batches, hitDeadline, leaseLost: true };
    }

    // Advance ONLY after a confirmed terminal MERGE. A throw here aborts the
    // loop with the cursor unchanged, so this batch re-exports next tick.
    await deps.mergeBatch(spec, rows);

    const last = rows[rows.length - 1];
    const lastTs = String(last[spec.watermark]);
    const lastId = String(last.id);
    await deps.saveCursor(key, lastTs, lastId);
    cursor = { last_ts: lastTs, last_id: lastId };

    exported += rows.length;
    batches += 1;

    // A short page means we caught up; stop until next tick.
    if (rows.length < opts.limit) break;
  }

  return { table: spec.table, key, exported, batches, hitDeadline };
}
