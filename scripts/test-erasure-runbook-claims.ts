// #1074: docs/pii-erasure-runbook.md states testable claims about
// erase_booking_pii, and it drifted from the function twice.
//
// The runbook is read by an operator honoring a data-subject deletion request
// under a response deadline, so a stale claim there is not a cosmetic docs bug:
// it makes the operator believe the erasure failed (or succeeded) when the
// opposite is true. Two instances, both live before this guard:
//
//   1. The documented return shape listed bookings/events/deliveries but NOT
//      `outbox`, which migration 0093 added. An operator comparing the real
//      return against the doc sees an unexplained extra field.
//   2. Step 2 told the operator to verify the audit row with
//      `encode(digest('person@example.com','sha256'),'hex')` on the email AS
//      TYPED, while the function hashes lower(trim(email)). Measured against
//      production 2026-07-29: the same address padded and mixed-case hashes to
//      1c5e9832... raw vs bf887269... normalized. Any email that is not already
//      lowercase and trimmed mismatches, and the operator concludes they are
//      looking at the wrong erasure.
//
// So the claims are DERIVED from the migration here rather than maintained by
// hand beside it (L41). The migration is the source of truth; the runbook has to
// keep up with it, and this fails the build when it does not.
//
// Run: node --experimental-strip-types scripts/test-erasure-runbook-claims.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
// The export's own table definitions, so claim 7's watermark exclusion is DERIVED
// from what the export lane actually keys on rather than hand listed beside it (L41).
import { MIRROR_TABLES } from "../src/lib/snowflake/export-core.ts";

const root = join(import.meta.dirname, "..");
const runbook = readFileSync(join(root, "docs", "pii-erasure-runbook.md"), "utf8");

// The live definition is the HIGHEST-numbered migration that defines the
// function, since it is created with `create or replace` (same rule as
// test-erase-booking-pii.ts; taking the first match pins superseded SQL).
const migrationsDir = join(root, "supabase", "migrations");
const migrationFile = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .reverse()
  .find((f) =>
    readFileSync(join(migrationsDir, f), "utf8").toLowerCase().includes("function erase_booking_pii"),
  );
assert(migrationFile !== undefined, "found the migration that defines erase_booking_pii");
const sql = migrationFile ? readFileSync(join(migrationsDir, migrationFile), "utf8") : "";

/**
 * Keys of the function's SUCCESS return. That is the LAST `return
 * jsonb_build_object(...)` in the body: the no-match early return
 * (`'erased', false, 'reason', ...`) comes first, and the audit_log insert's
 * jsonb_build_object is not a return at all.
 */
function successReturnKeys(body: string): string[] {
  const returns = [...body.matchAll(/return\s+jsonb_build_object\s*\(([\s\S]*?)\);/gi)];
  const last = returns.at(-1);
  if (!last) return [];
  return [...last[1].matchAll(/'([a-z_]+)'\s*,/gi)].map((m) => m[1]);
}

const keys = successReturnKeys(sql);
assert(keys.length > 0, "parsed the success return's keys out of the migration");
assert(keys.includes("erased"), "the parsed return includes 'erased' (sanity check on the parse)");

// Claim 1: every key the function really returns is named in the runbook, so an
// operator comparing the two sees no unexplained field (and no missing one).
for (const key of keys) {
  assert(
    new RegExp(`"${key}"`).test(runbook),
    `the runbook's documented return shape names the '${key}' key that erase_booking_pii returns`,
  );
}

// Claim 2: the runbook's hash-verification instruction hashes the NORMALIZED
// email, matching what the function audits. Checked on the instruction line
// itself rather than the whole file, so prose elsewhere cannot satisfy it.
// Only lines that actually COMPUTE a hash, not prose that mentions one: an
// `encode(...)` wrapper around a `sha256(`/`digest(` call. Matching prose too
// made this fail on a sentence explaining the normalization rule.
const hashLines = runbook
  .split("\n")
  .filter((l) => /encode\s*\(/i.test(l) && /(?:sha256|digest)\s*\(/i.test(l));
assert(hashLines.length > 0, "the runbook shows the operator how to recompute the audited email hash");
for (const line of hashLines) {
  assert(
    /lower\s*\(\s*trim\s*\(/i.test(line),
    `the hash instruction normalizes with lower(trim(...)) like the function does, not the email as typed: ${line.trim()}`,
  );
}

// The function normalizes exactly this way; if that ever changes, the runbook
// instruction this guard pins would be wrong in a way the check above cannot see.
assert(
  /nullif\s*\(\s*lower\s*\(\s*trim\s*\(\s*target_email\s*\)\s*\)/i.test(sql),
  "the function still normalizes with lower(trim(target_email)) (the shape the runbook is pinned to)",
);

// Claim 3: the no-match return the runbook quotes for an already-erased person.
assert(
  /"reason"\s*:\s*"no-match"/.test(runbook),
  "the runbook quotes the no-match return an already-erased (idempotent) re-run produces",
);
assert(
  /'no-match'/.test(sql),
  "the function really returns reason 'no-match' when nothing matches",
);

// Claim 4: the runbook points at the automated residual watch. The Snowflake
// purge is a manual operator step, and the erasure-audit lane is the only thing
// that catches an operator who skipped it, so an operator reading only this
// runbook must know it exists.
assert(
  /erasure-audit/.test(runbook),
  "the runbook names the /api/cron/erasure-audit lane that watches for residual warehouse PII",
);

// Claim 5: every column the runbook's Snowflake SQL names really exists in the
// warehouse, so each statement an operator pastes actually runs.
//
// #1197: step 3's webhook_deliveries purge set `payload_erased = true`, a column
// that exists only on the Supabase side (it is the flag applySkipRedacted uses to
// freeze the row from re-export) and was never in the warehouse DDL or the export
// column list. Snowflake rejects the whole statement with an invalid identifier,
// so the payloads were never purged. Measured against production 2026-07-31: the
// other three statements returned 0 residual and this one left 3, and the
// erasure-audit lane had been re-paging every 6 hours since 2026-07-29 because of
// it. The step was written and its verify query was written, but the SQL was never
// executed against the real warehouse schema, so it read as correct forever (L52).
//
// Derived from docs/snowflake-setup.sql (the DDL that provisions the warehouse)
// rather than from a hand-kept list, so a column renamed there cannot leave this
// guard passing against a stale copy (L41).
const ddl = readFileSync(join(root, "docs", "snowflake-setup.sql"), "utf8");

/** Column names per warehouse table, parsed out of the provisioning DDL. */
function warehouseColumns(schema: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const table of schema.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_]+)\s*\(([\s\S]*?)\n\)/gi,
  )) {
    const cols = new Set<string>();
    for (const line of table[2].split("\n")) {
      // "  attendee_email      VARCHAR," : an identifier followed by a type.
      const col = line.trim().match(/^([a-z_][a-z0-9_]*)\s+[A-Z]/i);
      if (col) cols.add(col[1].toLowerCase());
    }
    out.set(table[1].toLowerCase(), cols);
  }
  return out;
}

/**
 * Tokens that are SQL syntax or a function name rather than a column. Kept as a
 * denylist (not an allowlist of known columns) so a genuinely unknown identifier
 * is FLAGGED by default: a column this guard cannot recognize is the bug it
 * exists to catch, and defaulting it to "probably fine" would reproduce #1197.
 */
const NOT_A_COLUMN = new Set([
  "select", "count", "from", "where", "and", "or", "in", "is", "not", "null", "true", "false",
  "set", "update", "string", "as", "case", "when", "then", "else", "end", "limit", "order",
  "by", "desc", "slate", "public", "object_construct", "object_insert", "object_delete",
]);

/**
 * Every (table, columns) pair the runbook's Snowflake statements reference. A
 * statement runs from `update SLATE.PUBLIC.<table>` or `from SLATE.PUBLIC.<table>`
 * up to its terminator, and a column is an identifier that is either assigned to
 * (`col = ...`) or compared (`col in (...)`, `col is not null`). A VARIANT path
 * suffix is dropped, so `payload:attendee:email` counts as the `payload` column.
 */
function snowflakeColumnsNamed(doc: string): { table: string; columns: string[] }[] {
  const found: { table: string; columns: string[] }[] = [];
  for (const stmt of doc.matchAll(
    /\b(?:update|from)\s+SLATE\.PUBLIC\.([a-z_]+)([\s\S]*?)(?=;|\n\s*\(select|\n\n)/gi,
  )) {
    const named = new Set<string>();
    for (const m of stmt[2].matchAll(/([a-z_][a-z0-9_]*)\s*=/gi)) named.add(m[1].toLowerCase());
    for (const m of stmt[2].matchAll(/([a-z_][a-z0-9_]*)\s*(?::[a-z_:]+)?\s+(?:in|is)\b/gi)) {
      named.add(m[1].toLowerCase());
    }
    found.push({
      table: stmt[1].toLowerCase(),
      columns: [...named].filter((n) => !NOT_A_COLUMN.has(n)),
    });
  }
  return found;
}

const warehouse = warehouseColumns(ddl);
assert(warehouse.size > 0, "parsed the warehouse table definitions out of docs/snowflake-setup.sql");
assert(
  (warehouse.get("webhook_deliveries")?.size ?? 0) > 0,
  "sanity check on the DDL parse: webhook_deliveries has columns",
);

const referenced = snowflakeColumnsNamed(runbook);
// Sanity check on the statement parse: a regex that stopped matching would leave
// every claim below passing vacuously.
//
// Step 3's purge touches four tables and step 4's verify reads four, so eight.
//
// An earlier version of this comment said the verify touched THREE, on the
// grounds that `booking_outbox` is out of erasure scope. That is half of #1199's
// decision: the outbox PAYLOAD is out of scope (a reason code, staff free text,
// timestamps and internal ids), but `last_error` is IN scope, and step 4 has
// counted it as `outbox_error_residual` since #1205. Left uncorrected, the
// sentence read as a deliberate exemption for a table the verify really does
// cover (L346).
assert(
  referenced.length >= 8,
  `parsed the runbook's Snowflake statements (found ${referenced.length}, expected at least 8)`,
);

for (const { table, columns } of referenced) {
  const known = warehouse.get(table);
  assert(known !== undefined, `the runbook's SLATE.PUBLIC.${table} is a table the warehouse DDL creates`);
  for (const column of columns) {
    assert(
      known?.has(column) ?? false,
      `the runbook's Snowflake SQL names ${table}.${column}, which the warehouse DDL really has ` +
        `(a column that exists only in Supabase makes Snowflake reject the whole statement)`,
    );
  }
}

// Claim 6: the webhook_deliveries purge must PRESERVE the key its own verification
// searches on, so step 4 and the erasure-audit lane stay real checks.
//
// Step 4 and src/lib/snowflake/erasure-audit.ts both locate these rows by
// `payload:booking_id`, and that is the ONLY handle they have: the warehouse copy
// carries no payload_erased and no dedupe_key (docs/snowflake-setup.sql). So a purge
// that empties the payload wholesale destroys the very key that proves it worked, and
// the verify then returns 0 whether the purge ran or the rows were never there. That
// is a check that cannot fail, which is worse than no check (L1), and it is the same
// shape as #1199 (a control reporting all clear on data it cannot see).
//
// Also note the purge must not lean on OBJECT_DELETE. Snowflake documents that call as
// FAILING on a key absent from a structured object and documents nothing at all for the
// variant case, while these payloads legitimately omit some keys (`reason` is null on
// booking.created). OBJECT_CONSTRUCT is documented to drop a key whose value is NULL,
// so building the survivor explicitly is the only well-defined form here.
const webhookPurge = runbook
  .split("\n")
  .find((l) => /set\s+payload\s*=/i.test(l) && !/^\s*\(/.test(l));
assert(
  webhookPurge !== undefined,
  "found the runbook's webhook_deliveries payload purge assignment",
);
assert(
  /booking_id/i.test(webhookPurge ?? ""),
  "the webhook purge keeps payload:booking_id, the only key step 4 and the erasure-audit " +
    `lane can find these rows by: ${(webhookPurge ?? "").trim()}`,
);
assert(
  !/object_delete/i.test(webhookPurge ?? ""),
  "the webhook purge does not use OBJECT_DELETE, whose behavior on an absent key is " +
    `undocumented for these variant payloads: ${(webhookPurge ?? "").trim()}`,
);

// Positive controls for claim 6: both ways of blinding the check must be caught.
for (const bad of [
  "   set payload = object_construct()",
  "   set payload = object_delete(payload, 'attendee', 'prefill')",
]) {
  assert(
    !/booking_id/i.test(bad) || /object_delete/i.test(bad),
    `positive control: claim 6 rejects the blinding form "${bad.trim()}"`,
  );
}

// Positive control for claim 5: re-introducing the #1197 shape must be caught.
// Without this, a parse that quietly matched nothing would leave the loop above
// asserting zero columns and reading as full coverage.
const reintroduced = snowflakeColumnsNamed(
  "update SLATE.PUBLIC.webhook_deliveries\n   set payload = object_construct(), payload_erased = true\n where payload:booking_id::string in ('x');",
);
eq(reintroduced.length, 1, "positive control: parsed the reintroduced bad statement");
assert(
  reintroduced[0].columns.includes("payload_erased"),
  "positive control: the parse SEES payload_erased as a named column",
);
assert(
  !(warehouse.get("webhook_deliveries")?.has("payload_erased") ?? true),
  "positive control: payload_erased is genuinely absent from the warehouse DDL, so claim 5 would fail on it",
);

// Positive control: this guard must be able to FAIL. Strip the outbox key from a
// copy of the runbook and confirm the claim-1 check would catch it, so the guard
// cannot rot into a no-op if the parse silently returns nothing.
const mutated = runbook.replace(/"outbox"/g, '"outbox_RENAMED"');
assert(
  keys.includes("outbox"),
  "positive control: 'outbox' is one of the parsed return keys (added by 0093)",
);
assert(
  !new RegExp('"outbox"').test(mutated),
  "positive control: the claim-1 check fails when the runbook stops naming a returned key",
);

eq(
  successReturnKeys("return jsonb_build_object('erased', false, 'reason', 'x');\n" + sql),
  keys,
  "positive control: an earlier no-match return does not shadow the success return's keys",
);

// --- Claim 7 (#1205, generalized to every erased table in #1207): the warehouse
// purge clears EVERY PII column the erasure function clears in Supabase, on
// EVERY table it touches.
//
// Redacting in Supabase can set a flag that FREEZES the row from re-export
// (applySkipRedacted, src/lib/snowflake/skip-redacted.ts), which is deliberate so
// the mirror cannot clobber a redaction. The consequence that bit us: the
// redaction then propagates NOWHERE, so Snowflake keeps whatever it last held and
// step 3's statement is the ONLY thing that ever clears it.
//
// #1205 was `webhook_deliveries.last_response`, which holds up to 1000 chars of
// the subscriber's response body and commonly quotes the request, so it carries
// attendee name/email/phone (docs/pii-retention.md already calls it "may echo
// PII"). The migration nulls it; the runbook cleared `payload` only; the row was
// frozen from export, so the person's contact data stayed in the warehouse
// permanently. Classic N minus 1 of N (L38).
//
// #1207 is the same defect one table over, and it is why this loop is no longer
// wired to a single table. `booking_outbox.steps` carries `steps[].error`, which
// the migration nulls per element and the warehouse purge did not touch at all.
// `booking_outbox` is NOT frozen from re-export, so a row still present in
// Supabase self-heals on the next export tick, but outbox retention is a hard
// DELETE: once the Supabase row has aged out there is nothing left to MERGE, and
// the runbook says so under "Never wait for the export to fix a booking_outbox
// residual". So the warehouse copy of an erased person's error text was
// unreachable, and step 4 reported all zeros over it.
//
// Naming one table was the whole defect: a guard wired to a third of the surface
// reads as coverage of all of it. Derived from the migration (L41) so a column
// added to the erasure function cannot be silently missed in the warehouse, and
// derived per TABLE so a fourth table cannot be either.

/** Every table the erasure function updates, in the order it updates them. */
function erasedTablesIn(body: string): string[] {
  return [...body.matchAll(/update\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase());
}

function erasedColumnsFor(body: string, table: string): string[] {
  // The function's `update <table> set a = x, b = y where ...` block.
  const stmt = new RegExp(`update\\s+${table}\\b([\\s\\S]*?)where\\b`, "i").exec(body);
  if (!stmt) return [];
  return [...stmt[1].matchAll(/(\w+)\s*=/g)].map((m) => m[1].toLowerCase());
}

/** The runbook's Snowflake `update SLATE.PUBLIC.<table> ... where` block. */
function warehousePurgeFor(doc: string, table: string): string {
  const m = new RegExp(
    `update\\s+SLATE\\.PUBLIC\\.${table}\\b([\\s\\S]*?)where\\b`,
    "i",
  ).exec(doc);
  return m ? m[1] : "";
}

const erasedTables = erasedTablesIn(sql);
eq(
  erasedTables,
  ["bookings", "booking_events", "webhook_deliveries", "booking_outbox"],
  "sanity check on the migration parse: the four tables erase_booking_pii updates",
);

/**
 * A column the erasure function sets that the warehouse purge must NOT set, per
 * table, with the reason. Two kinds, and only the first was anticipated in #1207:
 *
 *   - A watermark. `booking_outbox` has no `set_updated_at` trigger, so 0093
 *     stamps `updated_at` itself, and that stamp is what makes the export
 *     overwrite the warehouse copy. It is bookkeeping, not PII, and the warehouse
 *     copy of it MIRRORS Supabase: a purge that wrote it would corrupt the very
 *     column `buildVerifySql` compares to decide whether a row is archived. Taken
 *     from MIRROR_TABLES rather than hand listed, so it cannot drift from what the
 *     export actually keys on (L96).
 *   - A column the warehouse does not have. `payload_erased` and `pii_redacted_at`
 *     are Supabase-only; claim 5 already asserts that naming one in a Snowflake
 *     statement is an error, because Snowflake would reject the whole statement
 *     (#1197). Handled by the DDL check below rather than by an entry here.
 */
const watermarkOf = new Map(MIRROR_TABLES.map((t) => [t.table, t.watermark]));
assert(
  watermarkOf.get("booking_outbox") === "updated_at",
  "sanity check: MIRROR_TABLES really names booking_outbox's watermark, so the exclusion is derived and not silently empty",
);

let claim7Checked = 0;
for (const table of erasedTables) {
  const supabaseErased = erasedColumnsFor(sql, table);
  assert(
    supabaseErased.length > 0,
    `sanity check on the migration parse: erase_booking_pii sets at least one column on ${table}`,
  );

  const warehousePurge = warehousePurgeFor(runbook, table);
  assert(
    warehousePurge !== "",
    `found the runbook's SLATE.PUBLIC.${table} purge statement`,
  );

  const required = supabaseErased.filter(
    (column) =>
      // Present in the warehouse at all: a Supabase-only column must NOT be named.
      (warehouse.get(table)?.has(column) ?? false) &&
      // And not the export's own watermark for this table.
      column !== watermarkOf.get(table),
  );
  assert(
    required.length > 0,
    `${table}: the loop found at least one column to require, so a parse that quietly ` +
      `stopped matching cannot read as coverage`,
  );

  for (const column of required) {
    claim7Checked += 1;
    assert(
      new RegExp(`\\b${column}\\b`, "i").test(warehousePurge),
      `the warehouse purge clears ${table}.${column}, which the erasure function clears in ` +
        `Supabase. The Supabase clear does not reach the warehouse on its own (a frozen row ` +
        `never re-exports, and a hard-deleted row has nothing left to MERGE), so this ` +
        `statement is the only thing that ever will (#1205, #1207)`,
    );
  }

  // Positive control, PER TABLE: blind this table's statement and prove the loop
  // above would have caught it. Without one per table, a regex that matched
  // nothing for three of the four would assert nothing and read as full coverage
  // (L1), which is exactly how the single-table version read before #1207.
  const victim = required[required.length - 1];
  const blinded = warehousePurge.replace(new RegExp(`\\b${victim}\\b`, "gi"), "blinded_column");
  assert(
    blinded !== warehousePurge,
    `positive control actually mutated the ${table} purge it checks`,
  );
  assert(
    !new RegExp(`\\b${victim}\\b`, "i").test(blinded),
    `positive control: claim 7 catches a warehouse purge that leaves ${table}.${victim} behind`,
  );
}

// The count is asserted, not just the loop, because a `required` that filtered
// everything out on every table would pass every assertion inside the loop while
// checking nothing at all (L98). Ten today: 4 on bookings, 1 on booking_events,
// 2 on webhook_deliveries, 3 on booking_outbox.
eq(claim7Checked, 10, "claim 7 checked every erased PII column across all four tables");

// --- Claim 8 (#1205): step 4's verify must READ the columns it claims to clear.
//
// The original verify counted `payload:attendee:email`, the column step 3 had
// just cleared, and never looked at last_response. So it returned 0 while the
// contact data sat in the warehouse, and the runbook says "do not consider the
// request honored until it returns all zeros". A check that certifies the wrong
// thing is worse than no check (L1/L11: a message may claim only what its check
// actually measured).
// Scoped to the FENCED CODE BLOCK holding the verify query, not a regex span
// across the whole document. An earlier version matched from the first `select`
// anywhere in the file to the last `_residual` alias, which swept in unrelated
// prose (the step 3 statement and the scope note both mention `reasonDetail`) and
// made these assertions answer about text that is not the query at all.
const verifyBlock = runbook
  .split("```")
  .find((block) => /\bbookings_residual\b/.test(block));
assert(verifyBlock !== undefined, "found the runbook's step 4 verify query block");
assert(
  /\blast_response\b/i.test(verifyBlock ?? ""),
  "step 4's verify reads webhook_deliveries.last_response, so it measures what it claims " +
    "rather than only the column step 3 already cleared (#1205)",
);

// --- Claim 9: step 4 verifies booking_outbox.last_error.
//
// Scope split, and the reason it is not symmetric. `booking_outbox`'s PAYLOAD is
// out of erasure scope: it carries only a reason code, staff-typed free text,
// timestamps and internal user ids, and incidental mentions in staff free text are
// deliberately not treated as PII requiring erasure (#1199, 2026-07-31). So no
// `reasonDetail` count belongs here.
//
// `last_error` is different and this was initially got wrong. Its text is
// `err.message` from whatever a step threw (`src/lib/booking/outbox.ts`), and two
// of those steps are OUTBOUND calls (a Google Calendar delete and a notify), so
// the message is the external service's, not ours. A calendar API error can quote
// an attendee's email address. So it may incidentally carry contact data, step 3
// clears it, and that clear needs verifying like any other.
assert(
  /booking_outbox/i.test(verifyBlock ?? "") && /\blast_error\b/i.test(verifyBlock ?? ""),
  "step 4's verify reads booking_outbox.last_error, which may incidentally carry contact data " +
    "from an external API error message, so step 3's clear of it is verified rather than assumed",
);

// The payload count must stay OUT: staff free text is out of scope by decision,
// and re-adding it would restore a count with no compliance meaning.
assert(
  !/reasonDetail/i.test(verifyBlock ?? ""),
  "step 4 does not count booking_outbox payload:reasonDetail, which is staff free text and " +
    "deliberately out of erasure scope (#1199)",
);

finish();
