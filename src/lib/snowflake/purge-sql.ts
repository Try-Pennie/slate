/**
 * The canonical Snowflake purge SQL for a data-subject erasure (#1128).
 *
 * The Supabase half of an erasure is a database function, so it is exercised
 * every time it runs. The warehouse half was four SQL statements living only in
 * `docs/pii-erasure-runbook.md`, which nothing executed. #1197 is what that
 * costs: one statement named `payload_erased`, a column that exists only in
 * Supabase, so Snowflake rejected it outright, the webhook payloads were never
 * purged, and the runbook's own verify still reported success. It had been
 * written, reviewed and read for two days without ever being run.
 *
 * So the SQL lives HERE, in code, and the runbook quotes this text rather than
 * owning its own copy. `scripts/test-erasure-purge-sql.ts` fails the build if the
 * two ever differ by a character. That matters more than it looks: if the doc
 * kept a separate copy, the probe below would only prove that the COPY compiles,
 * and the statements an operator actually pastes could rot untouched (L41).
 *
 * Everything in this module is pure. The IO lives in `purge.ts`.
 */

// Imported through the `@/` alias, not `./client`: this module is loaded by a
// node-native guard script, whose resolver hook understands the alias but not an
// extensionless relative path (scripts/path-alias-hooks.mjs).
import { escapeSqlLiteral } from "@/lib/snowflake/client";

/**
 * Step 3 of the runbook, verbatim. Redact in place: the warehouse keeps the
 * PII-free analytics rows and holds none of the person's contact data.
 *
 * Do not "tidy" any of this. Each line is load-bearing and the reasoning is in
 * the runbook next to the block:
 *   - `webhook_deliveries` clears `last_response` as well as `payload`, because
 *     blanking it in Supabase sets the flag that FREEZES the row from re-export,
 *     so the Supabase null never reaches the warehouse (#1205).
 *   - it keeps `payload:booking_id`, the only key the verify and the audit lane
 *     can find these rows by, instead of emptying the payload. Empty it and the
 *     verify returns 0 whether the purge worked or the rows were never there,
 *     which is a check that cannot fail (#1201).
 *   - it builds the survivor with `object_construct` rather than deleting keys
 *     with `object_delete`, which Snowflake documents as FAILING on a key absent
 *     from a structured object while these payloads legitimately omit keys.
 *   - `object_insert(..., null, true)` REMOVES the key: Snowflake omits a
 *     key-value pair whose value is SQL NULL, and the TRUE flag is required
 *     because the key may already be present.
 */
export const RUNBOOK_PURGE_BLOCK = `update SLATE.PUBLIC.bookings
   set attendee_name = null, attendee_email = null, attendee_phone = null,
       prefill = object_construct()
 where id in (<ids>);

update SLATE.PUBLIC.booking_events
   set reason_detail = null
 where booking_id in (<ids>);

update SLATE.PUBLIC.webhook_deliveries
   set payload = object_construct('booking_id', payload:booking_id),
       last_response = null
 where payload:booking_id::string in (<ids>);

update SLATE.PUBLIC.booking_outbox
   set payload = object_insert(payload, 'reasonDetail', null, true),
       steps = transform(steps, s variant -> object_insert(s::object, 'error', null, true)),
       last_error = null
 where booking_id in (<ids>);`;

/**
 * Step 4, verbatim. Every count must be 0 for the request to be honored.
 *
 * Each subselect reads the column its matching purge statement clears, never a
 * neighbouring one. The first version counted `payload:attendee:email` alone,
 * which step 3 had just cleared, so it certified the request honored while
 * `last_response` still held the person's contact data (#1205).
 */
export const RUNBOOK_VERIFY_BLOCK = `select
  (select count(*) from SLATE.PUBLIC.bookings
     where id in (<ids>) and attendee_email is not null) as bookings_residual,
  (select count(*) from SLATE.PUBLIC.booking_events
     where booking_id in (<ids>) and reason_detail is not null) as events_residual,
  (select count(*) from SLATE.PUBLIC.webhook_deliveries
     where payload:booking_id::string in (<ids>)
       and (payload:attendee:email is not null
            or last_response is not null)) as webhook_residual,
  (select count(*) from SLATE.PUBLIC.booking_outbox
     where booking_id in (<ids>)
       and (last_error is not null
            or array_size(filter(steps, s variant -> coalesce(s:error::string, '') <> '')) > 0)) as outbox_error_residual;`;

/**
 * The verify statement's columns, in order, and the table each one measures.
 *
 * The caller reads the four counts positionally, so a reordered subselect would
 * silently attribute a residual to the wrong table. `scripts/test-erasure-purge-sql.ts`
 * asserts this list matches the aliases in `RUNBOOK_VERIFY_BLOCK` in the same
 * order, so a reorder fails the build instead of mislabelling an alert.
 */
export const VERIFY_COLUMNS = [
  { alias: "bookings_residual", table: "bookings" },
  { alias: "events_residual", table: "booking_events" },
  { alias: "webhook_residual", table: "webhook_deliveries" },
  { alias: "outbox_error_residual", table: "booking_outbox" },
] as const;

/** The placeholder an operator replaces by hand, and these builders replace for real. */
const ID_PLACEHOLDER = "<ids>";

/**
 * The only tables these statements may touch. A statement outside this set is
 * refused rather than sent, so an edit to the block cannot widen what the lane
 * writes to without also changing this list under review.
 */
const ALLOWED_TARGETS = [
  "SLATE.PUBLIC.bookings",
  "SLATE.PUBLIC.booking_events",
  "SLATE.PUBLIC.webhook_deliveries",
  "SLATE.PUBLIC.booking_outbox",
] as const;

/** Verbs that must never appear: this path only ever nulls columns. */
const FORBIDDEN_VERBS = /\b(delete|drop|truncate|alter|grant|revoke|create)\b/i;

/**
 * The id the probe binds. Structurally incapable of matching a row: every id
 * Slate stores is a uuid, and this is not uuid-shaped, which is precisely what
 * makes it safe to execute these UPDATEs against the production warehouse.
 */
export const PROBE_SENTINEL_ID = "slate-purge-sql-probe-matches-nothing";

/**
 * A short label for a statement, for a log line or an alert: the mirror table it
 * writes, or "verify" for the read. Never the SQL itself, which is multi-line and
 * would arrive in Slack as a wall of text.
 */
export function statementLabel(statement: string): string {
  const m = /^update SLATE\.PUBLIC\.(\w+)/.exec(statement);
  return m ? m[1] : "verify";
}

/** Split a runbook block into individual statements (the SQL API takes one at a time). */
export function splitStatements(block: string): string[] {
  return block
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function idList(ids: string[]): string {
  if (ids.length === 0) {
    throw new Error("erasure purge: refusing to build a statement with no booking ids");
  }
  for (const id of ids) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error("erasure purge: refusing to build a statement with a blank booking id");
    }
  }
  return ids.map((id) => `'${escapeSqlLiteral(id)}'`).join(",");
}

/**
 * Substitute the id list, refusing anything that would widen the statement.
 *
 * These are the rails between an edit to the block above and an unbounded write
 * to the warehouse, so each refusal is asserted by a positive control in
 * `scripts/test-erasure-purge-sql.ts` rather than trusted.
 */
function substitute(statement: string, ids: string[], kind: "update" | "select"): string {
  if (!statement.includes(ID_PLACEHOLDER)) {
    throw new Error(`erasure purge: statement has no ${ID_PLACEHOLDER} placeholder, so it is unbounded`);
  }
  if (FORBIDDEN_VERBS.test(statement)) {
    throw new Error("erasure purge: statement contains a destructive verb; this path only nulls columns");
  }
  if (kind === "update") {
    const target = ALLOWED_TARGETS.find((t) => statement.startsWith(`update ${t}\n`));
    if (!target) {
      throw new Error("erasure purge: statement does not update one of the four permitted mirror tables");
    }
  } else if (!statement.startsWith("select")) {
    throw new Error("erasure purge: the verify statement must be a select");
  }
  if (!/\bwhere\b/.test(statement)) {
    throw new Error("erasure purge: statement has no where clause, so it is unbounded");
  }

  const bound = statement.replaceAll(ID_PLACEHOLDER, idList(ids));
  if (bound.includes(ID_PLACEHOLDER)) {
    throw new Error("erasure purge: placeholder survived substitution");
  }
  return bound;
}

/** The four redact-in-place statements, bound to these booking ids. */
export function buildPurgeStatements(ids: string[]): string[] {
  return splitStatements(RUNBOOK_PURGE_BLOCK).map((s) => substitute(s, ids, "update"));
}

/** The verify statement, bound to these booking ids. Returns four residual counts. */
export function buildVerifyStatement(ids: string[]): string {
  const [statement, ...rest] = splitStatements(RUNBOOK_VERIFY_BLOCK);
  if (rest.length > 0) throw new Error("erasure purge: the verify block must be a single statement");
  return substitute(statement, ids, "select");
}

/**
 * Every statement, bound to the sentinel. Running these proves the SQL compiles
 * and resolves against the real warehouse schema, which is exactly the failure
 * #1197 was, while changing nothing.
 *
 * It does NOT prove the statements clear fields on a real row: a zero-row
 * statement can only ever report zero rows. That limit is stated in the runbook
 * too, because a check may claim only what it measured.
 */
export function buildProbeStatements(): string[] {
  return [...buildPurgeStatements([PROBE_SENTINEL_ID]), buildVerifyStatement([PROBE_SENTINEL_ID])];
}
