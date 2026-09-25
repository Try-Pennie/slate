// Parser for the mirror-table DDL in docs/snowflake-setup.sql (#1116).
//
// The warehouse schema lives in that file, not in a migration, so nothing in the
// build has ever compared it against the column list the export lane actually
// sends (MIRROR_TABLES in src/lib/snowflake/export-core.ts). That was tolerable
// while every MERGE column came from the source row; it stopped being tolerable
// once the MERGE started writing `exported_at` unconditionally, because a mirror
// table missing that column now fails every export.
//
// So the guard derives the expectation from the DDL rather than restating it
// (L41): parse the CREATE TABLE blocks and compare. Lives here, apart from the
// test file, so the parser is itself unit-testable and so the runner's
// `scripts/test-*.ts` glob does not pick it up as a suite.

export interface ParsedColumn {
  name: string;
  /** The declared Snowflake type, upper-cased (VARCHAR, TIMESTAMP_NTZ, ...). */
  type: string;
}

/**
 * Extract every `CREATE TABLE IF NOT EXISTS <name> ( ... )` block, keyed by
 * table name. Handles the file's actual shape: one column per line, an optional
 * trailing comma, inline column constraints (`PRIMARY KEY`), `--` comment lines,
 * and a trailing `CLUSTER BY (...)` after the closing paren.
 */
export function parseSnowflakeTables(sql: string): Map<string, ParsedColumn[]> {
  const tables = new Map<string, ParsedColumn[]>();
  const blockRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)\s*\(([\s\S]*?)\n\)/g;

  for (const m of sql.matchAll(blockRe)) {
    const table = m[1].replace(/"/g, "").split(".").pop()!;
    tables.set(table, parseColumnBlock(m[2]));
  }
  return tables;
}

function parseColumnBlock(body: string): ParsedColumn[] {
  const cols: ParsedColumn[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (line === "" || line.startsWith("--")) continue;
    // A table-level constraint is not a column.
    if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CONSTRAINT|CHECK)\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    cols.push({ name: parts[0], type: parts[1].toUpperCase() });
  }
  return cols;
}

/** One thing wrong with one mirror table. */
export interface MirrorSchemaProblem {
  table: string;
  problem: string;
}

export interface MirrorTableExpectation {
  table: string;
  cols: Array<{ name: string }>;
}

/**
 * Compare the export lane's column lists against the parsed DDL. Returns one
 * problem per divergence; an empty array means the mirror DDL can accept every
 * MERGE the lane builds.
 */
export function findMirrorSchemaProblems(
  expected: MirrorTableExpectation[],
  declared: Map<string, ParsedColumn[]>,
  loadStampCol: string,
  loadStampType: string,
): MirrorSchemaProblem[] {
  const problems: MirrorSchemaProblem[] = [];

  for (const spec of expected) {
    const cols = declared.get(spec.table);
    if (!cols) {
      problems.push({ table: spec.table, problem: "no CREATE TABLE block in docs/snowflake-setup.sql" });
      continue;
    }
    const byName = new Map(cols.map((c) => [c.name, c]));

    for (const c of spec.cols) {
      if (!byName.has(c.name)) {
        problems.push({ table: spec.table, problem: `exported column ${c.name} is not declared` });
      }
    }

    const stamp = byName.get(loadStampCol);
    if (!stamp) {
      // The MERGE writes this column on every branch, so a table without it
      // rejects every export, not just some.
      problems.push({ table: spec.table, problem: `missing the ${loadStampCol} load stamp the MERGE always writes` });
    } else if (stamp.type !== loadStampType) {
      problems.push({
        table: spec.table,
        problem: `${loadStampCol} is ${stamp.type}, expected ${loadStampType}`,
      });
    }

    if (spec.cols.some((c) => c.name === loadStampCol)) {
      problems.push({
        table: spec.table,
        problem: `${loadStampCol} must not be an exported source column; the warehouse stamps it`,
      });
    }
  }

  return problems;
}

/**
 * The columns each mirror table was FIRST provisioned with (#1096, the file as of
 * commit b1d2f492, the day the warehouse was created). Every CREATE in the setup
 * file is IF NOT EXISTS, so re-running it against the live warehouse never adds a
 * column declared after that day: only an ALTER does. That is why this is frozen
 * history rather than derived from the current file, which by construction already
 * holds every column and so could never report one as missing its ALTER (#2772).
 * Never add to it: a column declared after provisioning gets an ALTER instead.
 */
export const PROVISIONED_MIRROR_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  bookings: [
    "id", "org_id", "bucket_id", "event_type_id", "assigned_user_id", "agent_name", "agent_email",
    "starts_at", "ends_at", "original_starts_at", "original_ends_at", "timezone", "status",
    "salesforce_id", "attendee_name", "attendee_email", "attendee_phone", "prefill", "gcal_event_id",
    "manage_token", "idempotency_key", "external_id", "routing_trace", "allow_double_book",
    "reschedule_seq", "created_at", "updated_at", "exported_at",
  ],
  webhook_deliveries: [
    "id", "endpoint_id", "event", "payload", "status", "attempts", "last_response", "suppressed",
    "created_at", "updated_at", "exported_at",
  ],
  booking_outbox: [
    "id", "booking_id", "action", "status", "steps", "payload", "lease_until", "attempts",
    "last_error", "next_attempt_at", "created_at", "updated_at", "exported_at",
  ],
  booking_events: [
    "id", "booking_id", "action", "initiator", "reason_code", "reason_detail", "from_starts_at",
    "to_starts_at", "from_agent_user_id", "to_agent_user_id", "actor_user_id", "acting_as_user_id",
    "lead_time_minutes", "reschedule_seq", "created_at", "exported_at",
  ],
  audit_log: ["id", "org_id", "actor_id", "action", "target_id", "details", "created_at", "exported_at"],
  routing_decisions: [
    "id", "org_id", "booking_id", "bucket_code", "bucket_id", "requested_tier", "booked_tier",
    "chosen_user_id", "considered", "excluded", "empty_pool_fallback", "tier_fallback",
    "rungs_dropped", "outcome", "created_at", "exported_at",
  ],
};

/**
 * Every `ALTER TABLE IF EXISTS <t> ADD COLUMN IF NOT EXISTS <col> <TYPE>;` in the
 * file, keyed by table. Only the idempotent form counts: a bare ADD COLUMN errors
 * the second time the file is run, which is exactly the re-run this list exists for.
 */
export function parseSnowflakeAddColumns(sql: string): Map<string, ParsedColumn[]> {
  const out = new Map<string, ParsedColumn[]>();
  const re = /^\s*ALTER\s+TABLE\s+IF\s+EXISTS\s+(\w+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+(\w+)\s*;/gim;
  for (const m of sql.matchAll(re)) {
    const table = m[1].toLowerCase();
    const list = out.get(table) ?? [];
    list.push({ name: m[2].toLowerCase(), type: m[3].toUpperCase() });
    out.set(table, list);
  }
  return out;
}

/**
 * A column declared in a CREATE block after the warehouse was provisioned reaches
 * the live warehouse only through a matching self-heal ALTER. Returns one problem
 * per declared column that has none, or whose ALTER names a different type than
 * the CREATE does (the ALTER is what actually runs, so its type is what ships).
 */
export function findMissingSelfHealAlters(
  declared: Map<string, ParsedColumn[]>,
  alters: Map<string, ParsedColumn[]>,
  provisioned: Readonly<Record<string, readonly string[]>>,
): MirrorSchemaProblem[] {
  const problems: MirrorSchemaProblem[] = [];
  for (const [table, cols] of declared) {
    const original = new Set(provisioned[table] ?? []);
    const altered = new Map((alters.get(table) ?? []).map((c) => [c.name, c]));
    for (const c of cols) {
      if (original.has(c.name)) continue;
      const alter = altered.get(c.name);
      if (!alter) {
        problems.push({
          table,
          problem: `${c.name} was declared after provisioning and has no ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS ${c.name} ${c.type};`,
        });
      } else if (alter.type !== c.type) {
        problems.push({ table, problem: `${c.name} is ${c.type} in the CREATE but ${alter.type} in its ALTER` });
      }
    }
  }
  return problems;
}
