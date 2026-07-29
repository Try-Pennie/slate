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

finish();
