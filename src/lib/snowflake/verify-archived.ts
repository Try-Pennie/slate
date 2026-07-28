/**
 * Prove the warehouse holds a row BEFORE Supabase destroys it (#1102).
 *
 * Why this exists rather than trusting the export watermark. Each retention lane
 * deletes rows older than its window (30 days for delivered outbox, 90 days for
 * webhook payloads, 12 months for routing decisions) and additionally requires
 * the row to sit below `export_cursor.last_ts`. That cursor is minutes old, so
 * the second predicate is satisfied by every candidate any of those lanes will
 * ever see. It is shaped like a gate and cannot fail. "The cursor is past
 * timestamp T" also says nothing about whether the specific row at T was
 * exported: a row committed with an earlier `updated_at` after the cursor moved
 * past it is skipped by the strictly-forward keyset fetch and never exported.
 * `booking_outbox` is the live example, because it has no `set_updated_at`
 * trigger and its writers stamp `updated_at` from the Worker's own clock.
 *
 * So the only trustworthy signal is a read-back of the row itself, which is what
 * this module does. Three outcomes are kept deliberately DISTINCT (L11), because
 * collapsing them is how a broken read becomes a confident answer:
 *
 *   archived  the warehouse has this id at a version no older than Supabase's
 *   absent    the warehouse does not have this id at all
 *   stale     the warehouse has it, but an older version
 *
 * A failed or malformed warehouse read is none of the above: it throws. An empty
 * or short response must never read as "nothing verified", which the caller would
 * otherwise interpret as the warehouse admitting it lacks the rows (the
 * #35/#166/#277 false-empty class).
 *
 * The version comparison happens INSIDE Snowflake. A TIMESTAMP_TZ read back
 * through the SQL API is not an ISO-8601 string, so comparing it to a Supabase
 * timestamp in JavaScript would be a silent-offset bug. Snowflake knows both
 * types, so it does the comparison and returns booleans.
 */

import { escapeSqlLiteral, executeStatement } from "./client";
import { readSnowflakeConfig } from "./config";

/** A Supabase row up for destruction: its id and its watermark value. */
export interface Candidate {
  id: string;
  /** The row's `created_at`/`updated_at`, whichever the mirror is keyed on. */
  watermark: string;
}

export type VerifyState = "archived" | "absent" | "stale";

export interface VerifyVerdict {
  id: string;
  state: VerifyState;
}

export interface VerifyOutcome {
  /** Ids the warehouse provably holds at a current version: safe to destroy. */
  archived: string[];
  /** Everything else, with WHY, for the caller to alert on and quarantine. */
  problems: VerifyVerdict[];
}

/**
 * Snowflake allows far more, but a batch is also a statement we have to build,
 * ship, and reason about. 500 matches the export lane's DEFAULT_BATCH and keeps
 * the statement around 40 KB.
 */
export const MAX_VERIFY_BATCH = 500;

/**
 * Ask the warehouse about a specific set of ids. LEFT JOIN (not an inner join or
 * an `IN` filter) so an absent row still comes back with `present = false`,
 * rather than being indistinguishable from a row we forgot to ask about.
 *
 * `table` and `watermarkCol` come from the in-repo mirror definitions, never from
 * user input. Ids and watermarks are ours too, but they are still escaped, the
 * same way buildMergeSql escapes its VALUES literals.
 */
export function buildVerifySql(table: string, watermarkCol: string, candidates: Candidate[]): string {
  if (candidates.length === 0) {
    throw new Error("buildVerifySql: no candidates; the caller must short-circuit an empty batch");
  }
  if (candidates.length > MAX_VERIFY_BATCH) {
    throw new Error(`buildVerifySql: ${candidates.length} candidates exceeds MAX_VERIFY_BATCH (${MAX_VERIFY_BATCH})`);
  }
  const values = candidates
    .map((c) => `('${escapeSqlLiteral(c.id)}', '${escapeSqlLiteral(c.watermark)}')`)
    .join(", ");
  return `
SELECT s.id,
       t.id IS NOT NULL AS present,
       (t.id IS NOT NULL AND t.${watermarkCol} >= TO_TIMESTAMP_TZ(s.wm)) AS current
FROM (VALUES ${values}) AS s(id, wm)
LEFT JOIN ${table} t ON t.id = s.id
`.trim();
}

/** The SQL API returns booleans as the strings "true"/"false". */
function toBool(v: unknown): boolean {
  return v === true || v === "true" || v === "TRUE" || v === 1 || v === "1";
}

/**
 * Turn the warehouse's answer into per-id verdicts, insisting the answer actually
 * covers the batch. Anything unexpected about its SHAPE throws: a short, empty,
 * duplicated, or foreign-id response means we cannot say what the warehouse holds,
 * which is not the same as it holding nothing.
 */
export function classifyVerifyRows(candidates: Candidate[], rows: unknown[][]): VerifyOutcome {
  if (rows.length !== candidates.length) {
    throw new Error(
      `snowflake verify: asked about ${candidates.length} rows, got ${rows.length}; refusing to treat a partial answer as a verdict`,
    );
  }
  const asked = new Set(candidates.map((c) => c.id));
  const byId = new Map<string, { present: boolean; current: boolean }>();

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 3) {
      throw new Error("snowflake verify: response row is missing columns; cannot classify");
    }
    const id = String(row[0]);
    if (!asked.has(id)) {
      throw new Error(`snowflake verify: response names id ${id}, which was not in the batch`);
    }
    if (byId.has(id)) {
      throw new Error(`snowflake verify: response names id ${id} twice; ambiguous verdict`);
    }
    byId.set(id, { present: toBool(row[1]), current: toBool(row[2]) });
  }

  const archived: string[] = [];
  const problems: VerifyVerdict[] = [];
  for (const c of candidates) {
    // Cannot be missing: sizes match, no duplicates, and every id was in `asked`.
    const r = byId.get(c.id)!;
    if (r.present && r.current) archived.push(c.id);
    else problems.push({ id: c.id, state: r.present ? "stale" : "absent" });
  }
  return { archived, problems };
}

/**
 * Verify a batch against the live warehouse. Throws when the mirror is not
 * configured: a caller about to delete must never read that as "verified".
 */
export async function verifyArchived(
  table: string,
  watermarkCol: string,
  candidates: Candidate[],
): Promise<VerifyOutcome> {
  if (candidates.length === 0) return { archived: [], problems: [] };
  const config = readSnowflakeConfig();
  if (!config) {
    throw new Error(`snowflake verify ${table}: mirror not configured, so nothing can be proven archived`);
  }
  const res = await executeStatement(config, buildVerifySql(table, watermarkCol, candidates));
  // `data` absent is a shape we cannot interpret, NOT an empty verdict.
  if (!res.data) {
    throw new Error(`snowflake verify ${table}: response carried no data block`);
  }
  return classifyVerifyRows(candidates, res.data);
}

export interface DestroyReport {
  candidates: number;
  destroyed: number;
  problems: VerifyVerdict[];
}

export interface DestroyVerifiedOpts {
  table: string;
  watermarkCol: string;
  candidates: Candidate[];
  /** Perform the destructive write on exactly these ids; return the row count. */
  destroy: (ids: string[]) => Promise<number>;
  /** Injectable seam so this is testable with no warehouse (L2). */
  verify?: (table: string, watermarkCol: string, candidates: Candidate[]) => Promise<VerifyOutcome>;
  /**
   * Re-send rows the warehouse could not confirm, so a refusal is recoverable
   * instead of permanent (#1102). Called BEFORE the refusal throw, so the lane
   * both alerts today and is likely to succeed tomorrow. Must not throw.
   */
  repair?: (table: string, ids: string[]) => Promise<number>;
}

/**
 * The one place the verify-then-destroy contract lives, so all three retention
 * lanes share it instead of each re-deriving it.
 *
 * Two throws, both deliberate, both cases where a silent success is the actual
 * danger:
 *
 *   - Candidates existed but NONE verified. The lanes only offer up rows the
 *     export watermark says are archived, so a wholesale failure to confirm any
 *     of them means the watermark is lying about coverage. Reporting "0 pruned"
 *     there is indistinguishable from a quiet day.
 *   - Rows verified but the destructive write touched none of them. The write
 *     silently did nothing, which means the predicate and the verified set
 *     disagree.
 *
 * An empty candidate set is NOT an error: that is a genuinely quiet day, which is
 * every day until the first retention window is crossed.
 */
export async function destroyVerified(opts: DestroyVerifiedOpts): Promise<DestroyReport> {
  const { table, watermarkCol, candidates, destroy } = opts;
  const verify = opts.verify ?? verifyArchived;

  if (candidates.length === 0) return { candidates: 0, destroyed: 0, problems: [] };

  const { archived, problems } = await verify(table, watermarkCol, candidates);

  // Repair BEFORE the refusal throw. The rows the warehouse could not confirm are
  // exactly the rows that need re-sending, and doing it here (rather than leaving
  // it to an operator) is what stops a single missed row from making the refusal
  // permanent: the export cursor is strictly forward, so nothing else revisits it.
  if (problems.length > 0 && opts.repair) {
    await opts.repair(
      table,
      problems.map((p) => p.id),
    );
  }

  if (archived.length === 0) {
    throw new Error(
      `${table}: ${candidates.length} row(s) were eligible and the export watermark says archived, but the warehouse confirmed NONE ` +
        `(${summarize(problems)}). Refusing to destroy anything.`,
    );
  }

  const destroyed = await destroy(archived);
  if (destroyed === 0) {
    throw new Error(
      `${table}: ${archived.length} row(s) verified archived but the destructive write affected 0 rows; predicate and verified set disagree`,
    );
  }
  return { candidates: candidates.length, destroyed, problems };
}

function summarize(problems: VerifyVerdict[]): string {
  const absent = problems.filter((p) => p.state === "absent").length;
  const stale = problems.filter((p) => p.state === "stale").length;
  const ids = problems.slice(0, 5).map((p) => `${p.id}:${p.state}`).join(", ");
  return `absent=${absent} stale=${stale} first=[${ids}]`;
}
