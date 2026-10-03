/**
 * Is this logical dump worth keeping as the off platform backup? (#3076)
 *
 * `.github/workflows/db-backup.yml` runs `supabase db dump` five times (roles, the
 * schema, the data, and the migration history's schema and data) and uploads the
 * result to R2. A dump that came out empty, cut short, or pointed at the wrong
 * database still writes files, still uploads, and would still stamp the heartbeat,
 * so the backup would read as healthy while holding nothing anybody could restore
 * (L98). This is the judge that stands between the dump and the stamp.
 *
 * Pure: it reads text, never the filesystem, so `scripts/test-db-dump-check.ts`
 * drives every refusal with hand written fixtures. Imports nothing, because the
 * workflow runs it on bare node (scripts/test-dependency-free-scripts.ts).
 *
 * What it does NOT judge: whether the rows are the RIGHT rows. Only a restore can
 * answer that, which is why docs/dr-runbook.md carries a timed restore rehearsal.
 */

/** The five files one backup is made of, by the name each is uploaded under. */
export const DUMP_FILES = [
  "roles.sql",
  "schema.sql",
  "data.sql",
  "history_schema.sql",
  "history_data.sql",
] as const;
export type DumpFile = (typeof DUMP_FILES)[number];

/**
 * The tables the daily dump exists to protect: the ones the Snowflake mirror does
 * NOT carry (advisors, pools, hours, settings, time off), plus bookings, so a dump
 * that silently skipped the busiest table is refused too. Each must be declared in
 * the schema AND carry a complete COPY block in the data, because pg_dump writes a
 * COPY block for an empty table too, so a missing one is a dump that did not finish
 * or did not read that table.
 */
export const REQUIRED_TABLES = [
  "organizations",
  "users",
  "buckets",
  "bucket_members",
  "availability_schedules",
  "availability_rules",
  "business_hours",
  "booking_settings",
  "event_types",
  "ooo_requests",
  "agent_calendars",
  "bookings",
] as const;

/**
 * Tables that are never empty on a working Slate, so zero rows in the dump means
 * the read went somewhere other than the database we think it did (an empty
 * project, the wrong ref), not that the roster is empty. Bookings joined the list
 * once the pilot put real leads through Slate (hundreds a day since 2026-09-29).
 */
export const NEVER_EMPTY_TABLES = ["organizations", "users", "buckets", "bookings"] as const;

export interface DumpVerdict {
  ok: boolean;
  /** Every reason the dump is refused, so one run names all of them. */
  problems: string[];
  /** Data rows per required table, for the run log. */
  rows: Record<string, number>;
}

const copyHeader = (schema: string, table: string) => `COPY "${schema}"."${table}" `;

/**
 * Data rows in one table's COPY block, or null when the block is missing or never
 * reaches its OWN `\.` terminator (a dump cut short). A block that runs into the
 * next table's COPY header is truncated too: borrowing that table's terminator
 * would count the next table's rows as this one's and read as a plausible number.
 */
export function copyRowCount(data: string, schema: string, table: string): number | null {
  const lines = data.split("\n");
  const start = lines.findIndex((l) => l.startsWith(copyHeader(schema, table)));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "\\.") return i - start - 1;
    if (lines[i]!.startsWith('COPY "')) return null;
  }
  return null;
}

export function judgeDump(files: Partial<Record<DumpFile, string | null>>): DumpVerdict {
  const problems: string[] = [];
  const rows: Record<string, number> = {};

  for (const name of DUMP_FILES) {
    const text = files[name];
    if (text === undefined || text === null) problems.push(`${name} is missing`);
    else if (text.trim() === "") problems.push(`${name} is empty`);
  }

  const roles = files["roles.sql"] ?? "";
  if (roles.trim() !== "" && !/\b(CREATE|ALTER) ROLE\b/.test(roles)) {
    problems.push("roles.sql names no role, so it is not a role dump");
  }

  const schema = files["schema.sql"] ?? "";
  const data = files["data.sql"] ?? "";
  for (const table of REQUIRED_TABLES) {
    if (schema.trim() !== "" && !schema.includes(`CREATE TABLE IF NOT EXISTS "public"."${table}" (`)) {
      problems.push(`schema.sql does not create public.${table}`);
    }
    if (data.trim() === "") continue;
    const count = copyRowCount(data, "public", table);
    if (count === null) {
      problems.push(`data.sql has no complete COPY block for public.${table}`);
      continue;
    }
    rows[table] = count;
  }
  for (const table of NEVER_EMPTY_TABLES) {
    if (rows[table] === 0) {
      problems.push(`data.sql holds no rows for public.${table}, which is never empty on a working Slate`);
    }
  }

  // Every COPY that opens must close, wherever it is: a dump that stopped part way
  // through a table after the required ones would otherwise pass.
  if (data.trim() !== "") {
    const opened = data.split("\n").filter((l) => /^COPY "/.test(l)).length;
    const closed = data.split("\n").filter((l) => l === "\\.").length;
    if (opened !== closed) {
      problems.push(`data.sql opens ${opened} COPY blocks and closes ${closed}, so it was cut short`);
    }
  }

  const history = files["history_data.sql"] ?? "";
  if (history.trim() !== "") {
    const applied = copyRowCount(history, "supabase_migrations", "schema_migrations");
    if (applied === null || applied === 0) {
      problems.push(
        "history_data.sql holds no applied migrations, so a restore would not know which migrations it already has",
      );
    } else {
      rows["supabase_migrations.schema_migrations"] = applied;
    }
  }

  return { ok: problems.length === 0, problems, rows };
}
