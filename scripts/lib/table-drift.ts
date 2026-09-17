/**
 * Does production hold a table no migration created, or lack one that a migration did?
 * (#2294)
 *
 * Every guard in this repo enumerates tables from the MIGRATION FILES: the RLS scan, the
 * grants scan (#2271), the content lock. A table that exists only in the database is
 * therefore exempt from all of them by construction, and it is exempt invisibly, because a
 * scan that never reached it and a scan that found nothing wrong produce the same empty
 * result (L96, L456, L98).
 *
 * Measured 2026-09-17: production holds 41 tables in `public`, the migrations declare 40,
 * and the one difference is a backfill snapshot. It is default deny (RLS on, no policies),
 * so this is a blind spot rather than an exposure. The point is that the SET is unknown and
 * can grow with nothing saying so.
 *
 * Judging is here and pure so `scripts/test-table-drift.ts` can drive every outcome with no
 * database; the live read is `scripts/verify-table-drift-live.ts`.
 */

/** A table production holds that no migration created, recorded rather than left unexplained. */
export interface KnownUndeclaredTable {
  table: string;
  /** Why it exists and what it is for. An entry with no reason is evidence nobody reasoned about it (L233). */
  reason: string;
  /** The issue that removes it. An artifact with no exit stays forever (L523). */
  issue: number;
}

export const KNOWN_UNDECLARED_TABLES: readonly KnownUndeclaredTable[] = [
  {
    table: "availability_rules_backup_1255",
    reason:
      "The snapshot the roster hours backfill took before rewriting every agent's week, kept " +
      "so the change could be reversed. It is default deny, RLS on with no policies, and holds " +
      "630 rows as measured on 2026-09-17. It is recorded here rather than dropped because " +
      "deleting a safety copy is somebody's decision, not a tidy up.",
    issue: 2294,
  },
];

/**
 * Exit codes, worst first in RANK rather than in numeric order. 1 is reserved for having no
 * credentials, which is decided before anything is read so it can never be confused with a
 * finding.
 */
export const TABLE_DRIFT_EXIT = {
  agree: 0,
  nothingRead: 2,
  readFailed: 3,
  /** Production holds a table nothing declared and nothing records. */
  undeclared: 4,
  /** The migrations declare a table production does not have. */
  missing: 5,
  /** A record here names a table production no longer holds. */
  staleRecord: 6,
} as const;

export interface TableDriftVerdict {
  code: number;
  /** How many table names production holds, so agreement can never read as a broken read. */
  compared: number;
  /** How many the migrations declare. Reported beside `compared` because the two are only
   *  equal when nothing is recorded, and a reader should see which it is. */
  declaredCount: number;
  /** Live, declared by nothing, recorded by nothing. */
  undeclared: string[];
  /** Live, declared by nothing, and RECORDED. Not a finding, still reported. */
  recorded: string[];
  /** Declared by a migration and absent from production. */
  missing: string[];
  /** Recorded here and absent from production, so the record covers nothing. */
  staleRecords: string[];
}

/**
 * The verdict.
 *
 * An EMPTY list on either side is `nothingRead`, never agreement: Slate has tables and has
 * migrations, so an empty answer is the shape of a read or a parse that did not work.
 *
 * The run exits on its WORST finding, and carries every other one, so one departed table
 * cannot hide an undeclared one.
 */
export function judgeTableDrift(input: {
  live: readonly string[];
  declared: readonly string[];
  known?: readonly KnownUndeclaredTable[];
}): TableDriftVerdict {
  const known = input.known ?? KNOWN_UNDECLARED_TABLES;
  const live = [...new Set(input.live)].sort();
  const declared = new Set(input.declared);
  const liveSet = new Set(live);
  const knownByTable = new Map(known.map((k) => [k.table, k]));

  const base: TableDriftVerdict = {
    code: TABLE_DRIFT_EXIT.agree,
    compared: live.length,
    declaredCount: declared.size,
    undeclared: [],
    recorded: [],
    missing: [],
    staleRecords: [],
  };

  if (live.length === 0 || declared.size === 0) {
    return { ...base, code: TABLE_DRIFT_EXIT.nothingRead };
  }

  for (const t of live) {
    if (declared.has(t)) continue;
    if (knownByTable.has(t)) base.recorded.push(t);
    else base.undeclared.push(t);
  }
  base.missing = [...declared].filter((t) => !liveSet.has(t)).sort();
  base.staleRecords = known.filter((k) => !liveSet.has(k.table)).map((k) => k.table).sort();

  if (base.undeclared.length > 0) return { ...base, code: TABLE_DRIFT_EXIT.undeclared };
  if (base.missing.length > 0) return { ...base, code: TABLE_DRIFT_EXIT.missing };
  if (base.staleRecords.length > 0) return { ...base, code: TABLE_DRIFT_EXIT.staleRecord };
  return base;
}

/** What a reader is told, worst finding first, every finding carried. */
export function describeTableDrift(v: TableDriftVerdict): string {
  if (v.code === TABLE_DRIFT_EXIT.nothingRead) {
    return "nothing to compare: one side came back empty, which is a read or a parse that did not work rather than a database or a repo with no tables";
  }
  const lines: string[] = [];
  if (v.undeclared.length > 0) {
    lines.push(
      `${v.undeclared.length} table(s) in production that no migration created and nothing records: ${v.undeclared.join(", ")}. ` +
        "Each is invisible to the RLS scan, the grants scan and the content lock. Drop it, or record it with a reason and the issue that removes it.",
    );
  }
  if (v.missing.length > 0) {
    lines.push(
      `${v.missing.length} table(s) the migrations declare that production does not have: ${v.missing.join(", ")}. ` +
        "Either a migration is unapplied or something was dropped by hand.",
    );
  }
  if (v.staleRecords.length > 0) {
    lines.push(
      `${v.staleRecords.length} recorded artifact(s) production no longer holds: ${v.staleRecords.join(", ")}. ` +
        "The record covers nothing now and should be deleted.",
    );
  }
  if (lines.length === 0) {
    if (v.recorded.length === 0) {
      return `production holds ${v.compared} tables and the migrations declare all of them.`;
    }
    return (
      `production holds ${v.compared} tables, the migrations declare ${v.declaredCount}, and every ` +
      `difference is recorded. ${v.recorded.length} recorded artifact(s): ${v.recorded.join(", ")}.`
    );
  }
  const recorded = v.recorded.length ? `\nAlso present and recorded: ${v.recorded.join(", ")}.` : "";
  return lines.join("\n") + recorded;
}

/**
 * What the live read learned, or why it learned nothing.
 *
 * Separated from the fetch so every way of failing can be driven with no network. The two
 * failures are kept APART rather than folded into one empty answer: a refused request and a
 * payload whose shape changed send a reader to two different places, and neither is a
 * database with no tables (L10, L11).
 */
export type RootDocumentRead =
  | { ok: true; tables: string[] }
  | { ok: false; why: string };

/**
 * PostgREST's root document names every table it exposes, under `definitions`.
 *
 * `status` is the HTTP status; `body` is whatever came back, treated as hostile: it is an
 * external response and may be any shape at all.
 */
export function tablesFromRootDocument(input: { status: number; body: unknown }): RootDocumentRead {
  if (input.status < 200 || input.status >= 300) {
    return { ok: false, why: `the request was refused with status ${input.status}` };
  }
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    return { ok: false, why: "the reply was not an object, so this is not the root document" };
  }
  const defs = (input.body as { definitions?: unknown }).definitions;
  if (!defs || typeof defs !== "object" || Array.isArray(defs)) {
    return { ok: false, why: "the root document carried no definitions, so no table list was returned" };
  }
  const tables = Object.keys(defs as Record<string, unknown>).sort();
  // An empty definitions object is a real shape and a real answer of "no tables exposed",
  // which the judge scores as nothing read. It is NOT reported as a failed read here,
  // because the read worked; conflating the two would blame the network for a database
  // that genuinely exposes nothing.
  return { ok: true, tables };
}
