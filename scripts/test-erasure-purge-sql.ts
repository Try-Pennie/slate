// #1128: the runbook's Snowflake purge SQL had never been EXECUTED against the
// warehouse, only written and reviewed. That is how #1197 shipped a statement
// naming a Supabase-only column, which Snowflake rejected outright, so the
// payloads were silently never purged and the verify still returned zero.
//
// The fix has two halves. The runtime half lives in the erasure-audit lane,
// which now runs every one of these statements against the real warehouse with
// an id that cannot match anything, so a statement that no longer compiles pages
// instead of waiting for a deletion request to discover it.
//
// This file is the other half: the statements an operator PASTES and the
// statements Slate EXECUTES must be the same text. If the runbook held its own
// copy, the probe would only ever prove that the copy compiles (L41), and the
// operator's version could rot untouched. So the code owns the canonical block
// and this guard fails the build the moment the two drift in either direction.
//
// It also pins the substitution rails. The probe and the purge both interpolate
// an id list into an UPDATE, so the thing standing between a doc edit and an
// unbounded warehouse write is these refusals, and they are checked here with
// positive controls rather than trusted.
//
// Run: node --experimental-strip-types scripts/test-erasure-purge-sql.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  PROBE_SENTINEL_ID,
  RUNBOOK_PURGE_BLOCK,
  RUNBOOK_VERIFY_BLOCK,
  VERIFY_COLUMNS,
  buildProbeStatements,
  buildPurgeStatements,
  buildVerifyStatement,
  splitStatements,
} from "../src/lib/snowflake/purge-sql.ts";

const root = join(import.meta.dirname, "..");
const runbook = readFileSync(join(root, "docs", "pii-erasure-runbook.md"), "utf8");

/**
 * The fenced block that follows an explicit marker comment. Anchored on a marker
 * rather than "the Nth code block" or even the step heading, so the runbook can be
 * reordered or gain another example without silently re-pointing this guard at
 * some other SQL (which would leave it passing while checking nothing).
 */
function fencedBlockAfterHeading(md: string, headingPrefix: string): string | null {
  const at = md.indexOf(headingPrefix);
  if (at === -1) return null;
  const open = md.indexOf("\n```", at);
  if (open === -1) return null;
  const bodyStart = md.indexOf("\n", open + 1) + 1;
  const close = md.indexOf("\n```", bodyStart);
  if (close === -1) return null;
  return md.slice(bodyStart, close);
}

// --- Parity: the runbook's SQL and the executed SQL are one text -------------

const docPurge = fencedBlockAfterHeading(runbook, "<!-- canonical-sql: purge -->");
const docVerify = fencedBlockAfterHeading(runbook, "<!-- canonical-sql: verify -->");
assert(docPurge !== null, "found the purge SQL block behind its marker in the runbook");
assert(docVerify !== null, "found the verify SQL block behind its marker in the runbook");

eq(
  docPurge,
  RUNBOOK_PURGE_BLOCK,
  "the runbook's step 3 purge SQL is character-identical to the block Slate executes",
);
eq(
  docVerify,
  RUNBOOK_VERIFY_BLOCK,
  "the runbook's step 4 verify SQL is character-identical to the block Slate executes",
);

// Positive control: the comparison above must be capable of failing. An edit to
// either side has to be caught, so mutate a copy and confirm it no longer matches.
assert(
  RUNBOOK_PURGE_BLOCK.replace("attendee_email", "attendee_e_mail") !== docPurge,
  "positive control: a one-column edit to the purge SQL breaks the parity check",
);

// --- The block really is the four statements it claims to be -----------------

const purgeStatements = splitStatements(RUNBOOK_PURGE_BLOCK);
eq(purgeStatements.length, 4, "the purge block holds exactly four statements");
for (const table of ["bookings", "booking_events", "webhook_deliveries", "booking_outbox"]) {
  assert(
    purgeStatements.some((s) => s.includes(`update SLATE.PUBLIC.${table}`)),
    `the purge block updates ${table}`,
  );
}
eq(splitStatements(RUNBOOK_VERIFY_BLOCK).length, 1, "the verify block is a single statement");

// The four residual counts are read POSITIONALLY, so a reordered subselect would
// attribute a residual to the wrong table and page about the wrong thing. Pin the
// alias order against the list the reader uses.
const aliases = [...RUNBOOK_VERIFY_BLOCK.matchAll(/\bas (\w+)/g)].map((m) => m[1]);
eq(
  aliases.join(","),
  VERIFY_COLUMNS.map((c) => c.alias).join(","),
  "the verify statement's columns are in the order the residual counts are read in",
);
for (const col of VERIFY_COLUMNS) {
  assert(
    purgeStatements.some((s) => s.includes(`update SLATE.PUBLIC.${col.table}`)),
    `the verify column ${col.alias} measures a table the purge actually writes (${col.table})`,
  );
}

// Every statement must carry the placeholder, or substitution would produce a
// statement with no bound id at all.
for (const s of [...purgeStatements, ...splitStatements(RUNBOOK_VERIFY_BLOCK)]) {
  assert(s.includes("<ids>"), `every statement carries the <ids> placeholder: ${s.slice(0, 40)}...`);
}

// --- Substitution -----------------------------------------------------------

const built = buildPurgeStatements(["a1", "b2"]);
eq(built.length, 4, "buildPurgeStatements returns one statement per table");
for (const s of built) {
  assert(!s.includes("<ids>"), "no built statement still carries the placeholder");
  assert(s.includes("'a1','b2'"), "the built statement carries the quoted id list");
  assert(/\bwhere\b/.test(s), "the built statement is bounded by a where clause");
}
assert(
  buildVerifyStatement(["a1"]).includes("'a1'"),
  "buildVerifyStatement substitutes the id list too",
);

// A single quote in an id must not break out of the literal. These ids come from
// our own audit rows, so this is defence in depth rather than a live injection
// path, but the escaping is the reason it stays that way.
assert(
  buildPurgeStatements(["o'brien"])[0].includes("'o''brien'"),
  "an id containing a quote is escaped, not passed through",
);

// --- Refusals: the rails between a doc edit and an unbounded write ----------

function refuses(fn: () => unknown, what: string): void {
  try {
    fn();
    assert(false, `refuses ${what}`);
  } catch {
    assert(true, `refuses ${what}`);
  }
}

refuses(() => buildPurgeStatements([]), "an empty id list (would bind nothing)");
refuses(() => buildPurgeStatements([""]), "a blank id");
refuses(() => buildPurgeStatements(["  "]), "a whitespace-only id");
refuses(() => buildVerifyStatement([]), "an empty id list on the verify statement");

// --- The probe's sentinel ---------------------------------------------------

const probe = buildProbeStatements();
eq(probe.length, 5, "the probe covers all four purge statements plus the verify");
for (const s of probe) {
  assert(s.includes(PROBE_SENTINEL_ID), "every probe statement is bound to the sentinel id");
  assert(!s.includes("<ids>"), "no probe statement still carries the placeholder");
}

// The sentinel must be structurally incapable of matching a real row. Every id
// Slate stores is a uuid, so a value that is not uuid-shaped can never collide,
// and that is what makes executing these UPDATEs against production safe.
assert(
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(PROBE_SENTINEL_ID),
  "the probe sentinel is not uuid-shaped, so no real booking id can equal it",
);

finish();
