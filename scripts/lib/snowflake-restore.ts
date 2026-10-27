/**
 * The decisions behind restoring the mirrored tables from Snowflake (#3075).
 *
 * After a database restore, everything written to the six mirrored tables since the
 * restore point is gone from Supabase and still in the warehouse, because the export
 * lane copies them there every ten minutes (src/lib/snowflake/export-core.ts). So the
 * warehouse, not a person reading calendars, is the first source for those rows.
 * `scripts/restore-from-snowflake.ts` is the live command; this module is every rule
 * it applies, pure, so `scripts/test-snowflake-restore.ts` drives them with fakes.
 *
 * The rules, each of which is a way a naive copy back would do damage:
 *
 *  - NEVER WRITE OVER A NEWER ROW. Slate is serving again by the time this runs, so a
 *    booking cancelled after the restore is newer in Supabase than in the warehouse.
 *    An `updated_at` table is written only where the warehouse copy is strictly newer;
 *    an append only table only where the row is absent.
 *  - NEVER UN-REDACT. The export lane stops re-exporting a row once its PII is
 *    redacted (src/lib/snowflake/skip-redacted.ts), so the warehouse holds the last
 *    UNREDACTED version. Writing it back would undo a retention redaction or an
 *    erasure. A row Supabase holds redacted is never touched.
 *  - PARENTS FIRST. Bookings before the rows that reference them.
 *  - EVERY ROW CARRIES THE SAME KEYS, because a bulk upsert writes NULL into any key a
 *    sibling carries and a row omits (L705). Columns the mirror does not carry are
 *    left out of every row, so an update keeps Supabase's value and an insert takes
 *    the column default; UNMIRRORED_COLUMNS names each one and what that costs.
 */
import type { TableSpec } from "../../src/lib/snowflake/export-core.ts";
import type { ColSpec } from "../../src/lib/snowflake/merge.ts";

export type Row = Record<string, unknown>;

/** Parents first: every table below `bookings` references it by `booking_id`. */
export const RESTORE_ORDER = [
  "bookings",
  "booking_events",
  "booking_outbox",
  "routing_decisions",
  "webhook_deliveries",
  "audit_log",
] as const;

/**
 * The Supabase columns the mirror does not carry, and what a restored row gets for
 * each. `scripts/test-snowflake-restore.ts` derives the real difference from the row
 * types and the mirror spec and fails when this list disagrees with it, so a column
 * added to a mirrored table cannot be silently lost by a restore.
 */
export const UNMIRRORED_COLUMNS: Record<string, Record<string, string>> = {
  bookings: {
    pii_redacted_at: "never written; a row Supabase holds redacted is skipped instead",
    reminder_sent_for: "null on an inserted booking, so its reminder can be sent a second time",
    // #4282: the 1 hour email's record and the 24 hour email's send time.
    reminder_sent_at: "null on an inserted booking, so its 1 hour email ignores the two hour gap",
    hour_reminder_sent_for: "null on an inserted booking, so its 1 hour email can be sent a second time",
    attendee_first_name: "null on an inserted booking; the full name is restored",
    // #3672: a restored row that a cross bucket move replaced reads as an ordinary
    // cancel, so its old links say cancelled instead of opening the call that replaced it.
    replaced_by_booking_id: "null on an inserted booking, so a moved booking's old links show it cancelled",
    // #4200: who placed a coordinator's call is not mirrored; source still says the page.
    placed_by_user_id: "null on an inserted booking, so a coordinator's call no longer names who placed it",
  },
  webhook_deliveries: {
    dedupe_key: "null on an inserted delivery",
    payload_erased: "false on an inserted delivery; a row Supabase holds erased is skipped",
  },
  routing_decisions: {
    requested_code: "null on an inserted decision",
    catchall_applied: "false on an inserted decision",
    // #3272: refusal evidence, read while it is fresh; a restored decision loses it.
    requested_start: "null on an inserted decision",
    refusal_stage: "null on an inserted decision",
    stage_counts: "null on an inserted decision",
    lead_id: "null on an inserted decision",
    // #3797: the lost race judgement and its row proofs, read by later refusals and the
    // failure page while fresh; a restored decision loses them.
    offer_verdict: "null on an inserted decision",
    served_computed_at: "null on an inserted decision",
    stale_row_codes: "null on an inserted decision",
  },
  booking_outbox: {},
  booking_events: {},
  audit_log: {
    chain_seq:
      "assigned by the hash chain trigger (#3090) on insert, so a restored row is appended at the end of the chain rather than at its original place",
    chain_hash: "computed by the same trigger over the restored row, linking it to the current chain head",
  },
};

/** The Supabase column that says a row was redacted in place, per table. */
export const REDACTION_MARKER: Record<string, string> = {
  bookings: "pii_redacted_at",
  webhook_deliveries: "payload_erased",
};

/** Rows per Snowflake page. Small enough to stay in one result partition. */
export const PAGE_SIZE = 500;

/** The timestamp shape asked of Snowflake: ISO 8601 with microseconds and offset. */
const TS_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.FF6TZH:TZM'`;

export type RestorePoint = { ok: true; iso: string; ms: number } | { ok: false; reason: string };

/**
 * The restore point the operator typed. It must name its zone, because a bare
 * "2026-10-03 14:00" is read in whatever zone the machine is in, and an hour's
 * difference is an hour of bookings silently left out or written over.
 */
export function parseRestorePoint(raw: string | undefined, nowMs: number): RestorePoint {
  if (!raw || raw.trim() === "") {
    return { ok: false, reason: "no restore point given: set RESTORE_POINT to the UTC time the database was restored to" };
  }
  const text = raw.trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    return { ok: false, reason: `restore point "${text}" names no zone; write it in UTC with a trailing Z` };
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return { ok: false, reason: `restore point "${text}" is not a readable time` };
  if (ms > nowMs) return { ok: false, reason: `restore point "${text}" is in the future` };
  return { ok: true, iso: new Date(ms).toISOString(), ms };
}

function selectExpr(c: ColSpec): string {
  if (c.type === "timestamp_tz" || c.type === "timestamp_ntz") return `TO_VARCHAR(${c.name}, ${TS_FORMAT}) AS ${c.name}`;
  if (c.type === "variant") return `TO_JSON(${c.name}) AS ${c.name}`;
  return c.name;
}

export interface PageCursor {
  /** The last row's watermark, exactly as Snowflake formatted it. */
  ts: string;
  id: string;
}

/**
 * One keyset page of rows whose watermark is at or after the restore point, in
 * (watermark, id) order so a page boundary inside a run of equal stamps neither
 * skips nor repeats a row.
 */
export function buildPageQuery(
  spec: TableSpec,
  pointIso: string,
  after: PageCursor | null,
  limit = PAGE_SIZE,
): { sql: string; bindings: string[] } {
  const wm = spec.watermark;
  const cols = spec.cols.map(selectExpr).join(", ");
  const bindings = [pointIso];
  let where = `${wm} >= TO_TIMESTAMP_TZ(?)`;
  if (after) {
    where += ` AND (${wm} > TO_TIMESTAMP_TZ(?) OR (${wm} = TO_TIMESTAMP_TZ(?) AND id > ?))`;
    bindings.push(after.ts, after.ts, after.id);
  }
  return {
    sql: `SELECT ${cols} FROM ${spec.table} WHERE ${where} ORDER BY ${wm}, id LIMIT ${limit}`,
    bindings,
  };
}

/** Turn one Snowflake result row (every cell a string or null) into a Supabase row. */
export function decodeRow(spec: TableSpec, cells: readonly unknown[]): Row {
  if (cells.length !== spec.cols.length) {
    throw new Error(`${spec.table}: Snowflake returned ${cells.length} columns, expected ${spec.cols.length}`);
  }
  const row: Row = {};
  spec.cols.forEach((c, i) => {
    const cell = cells[i];
    if (cell === null || cell === undefined) {
      row[c.name] = null;
      return;
    }
    const text = String(cell);
    if (c.type === "number") {
      const n = Number(text);
      if (!Number.isFinite(n)) throw new Error(`${spec.table}.${c.name}: "${text}" is not a number`);
      row[c.name] = n;
    } else if (c.type === "boolean") {
      if (text === "true" || text === "1") row[c.name] = true;
      else if (text === "false" || text === "0") row[c.name] = false;
      else throw new Error(`${spec.table}.${c.name}: "${text}" is not a boolean`);
    } else if (c.type === "variant") {
      row[c.name] = JSON.parse(text);
    } else {
      row[c.name] = text;
    }
  });
  if (typeof row.id !== "string" || row.id === "") throw new Error(`${spec.table}: a row with no id`);
  return row;
}

/** What Supabase holds today for one id, as far as the decision needs to know. */
export interface CurrentRow {
  updated_at: string | null;
  redacted: boolean;
}

export interface TablePlan {
  table: string;
  /** Absent from Supabase: written back. */
  insert: Row[];
  /** Present and older than the warehouse copy: written back. */
  update: Row[];
  /** Present and at least as new as the warehouse copy: left alone. */
  keptNewer: string[];
  /** Redacted in Supabase: left alone, so a redaction is never undone. */
  keptRedacted: string[];
}

/**
 * Decide, row by row, what writing the warehouse back would do. A current
 * `updated_at` that cannot be read is NOT treated as older: the row is kept, because
 * overwriting a live row on a guess is the one mistake this cannot take back.
 */
export function planTable(spec: TableSpec, warehouse: Row[], current: Map<string, CurrentRow>): TablePlan {
  const plan: TablePlan = { table: spec.table, insert: [], update: [], keptNewer: [], keptRedacted: [] };
  for (const row of warehouse) {
    const id = String(row.id);
    const now = current.get(id);
    if (!now) {
      plan.insert.push(row);
      continue;
    }
    if (now.redacted) {
      plan.keptRedacted.push(id);
      continue;
    }
    if (spec.watermark === "created_at") {
      plan.keptNewer.push(id);
      continue;
    }
    const liveMs = now.updated_at === null ? NaN : Date.parse(now.updated_at);
    const warehouseMs = Date.parse(String(row.updated_at));
    if (Number.isFinite(liveMs) && Number.isFinite(warehouseMs) && warehouseMs > liveMs) plan.update.push(row);
    else plan.keptNewer.push(id);
  }
  return plan;
}

/** The plan as the operator reads it, one line per table. */
export function describePlan(plans: TablePlan[], apply: boolean): string[] {
  const verb = apply ? "wrote" : "would write";
  return plans.map(
    (p) =>
      `${p.table}: ${verb} ${p.insert.length} missing and ${p.update.length} older rows; ` +
      `left ${p.keptNewer.length} already current and ${p.keptRedacted.length} redacted`,
  );
}

/**
 * Whether a write is allowed, and against which project. Dry run is the default, and
 * APPLY=1 alone is not enough: the operator must also name the host the write goes to,
 * so a shell still pointing at production cannot be written to by accident.
 */
export function writeGate(
  env: { APPLY?: string; RESTORE_CONFIRM_HOST?: string },
  supabaseUrl: string | undefined,
): { apply: false } | { apply: true; host: string } | { refused: string } {
  if (env.APPLY !== "1") return { apply: false };
  let host: string;
  try {
    host = new URL(supabaseUrl ?? "").host;
  } catch {
    return { refused: "APPLY=1 but NEXT_PUBLIC_SUPABASE_URL is not a URL, so there is no target to confirm" };
  }
  if (!env.RESTORE_CONFIRM_HOST) {
    return { refused: `APPLY=1 writes to ${host}; set RESTORE_CONFIRM_HOST=${host} to confirm that is the restored project` };
  }
  if (env.RESTORE_CONFIRM_HOST !== host) {
    return { refused: `RESTORE_CONFIRM_HOST is ${env.RESTORE_CONFIRM_HOST} but the target is ${host}; nothing was written` };
  }
  return { apply: true, host };
}
