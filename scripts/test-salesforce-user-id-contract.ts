// The consumer contract for users.salesforce_user_id (#1587).
//
// There are NO consumers yet: #307's time off feed to PET and #329's manager
// drift check are the two that will arrive. That is exactly why this guard exists
// now rather than later. The rule ("a consumer refuses a null id rather than
// falling back to a name or an email match", L75) is otherwise a sentence in an
// issue, and a rule that lives only in prose is a hope (L27). The first person to
// need a rep's Salesforce id will have a `user` row in hand with an email on it,
// and `user.salesforce_user_id ?? user.email` is a one-character-looking change
// that silently hands back the exact property this column was added to remove.
//
// Two shapes are flagged, each blind where the other looks:
//
//   - a FALLBACK: the id ORed with an email or a name, in either order. Flagged
//     everywhere including the writer files, because nothing has a reason to do it.
//   - an UNGUARDED consumer: a file that reads the column and never mentions
//     `requireSalesforceUserId`. A hand-rolled null check is a second definition
//     of what a missing key means, and the next consumer copies whichever it
//     happens to find (L263).
//
// The scan logic lives in scripts/lib/scan-salesforce-user-id.ts so it can be
// driven against fixtures. Both directions are controlled here: the detector must
// catch each bad shape planted in a copy of the REAL tree (so it cannot rot into a
// no-op, L1/L98), and the real tree must be clean.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-salesforce-user-id-contract.ts

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  scanSalesforceUserId,
  WRITER_FILES,
} from "./lib/scan-salesforce-user-id.ts";

const ROOT = process.cwd();

// --- positive controls: the detector catches each bad shape -------------------
{
  const fallback = [
    "import { x } from './x';",
    "export function repKey(user: User): string {",
    "  return user.salesforce_user_id ?? user.email;",
    "}",
  ].join("\n");
  const found = scanSalesforceUserId(fallback, "src/lib/pet/feed.ts");
  assert(
    found.some((f) => f.kind === "fallback"),
    "an id ?? email fallback is caught",
  );
}
{
  const reversed = "const key = user.email || user.salesforce_user_id;";
  assert(
    scanSalesforceUserId(reversed, "src/lib/pet/feed.ts").some(
      (f) => f.kind === "fallback",
    ),
    "the reversed order (email || id) is caught too",
  );
}
{
  const camel = "const key = row.salesforceUserId || row.name;";
  assert(
    scanSalesforceUserId(camel, "src/lib/pet/feed.ts").some(
      (f) => f.kind === "fallback",
    ),
    "the camelCase spelling is caught (the planner's own field name)",
  );
}
{
  // A consumer that reads the column and rolls its own null handling.
  const unguarded = [
    "export function repKey(user: User): string | null {",
    "  const id = user.salesforce_user_id;",
    "  if (!id) return null;",
    "  return id;",
    "}",
  ].join("\n");
  const found = scanSalesforceUserId(unguarded, "src/lib/pet/feed.ts");
  assert(
    found.some((f) => f.kind === "unguarded"),
    "a consumer that never routes through requireSalesforceUserId is caught",
  );
  eq(found.length, 1, "and it is not double-reported as a fallback");
}
{
  // The compliant consumer shape, which must NOT be flagged. Without this the
  // guard could be satisfied by flagging everything, which is no guard at all.
  const compliant = [
    "import { requireSalesforceUserId } from '@/lib/salesforce/user-id-link';",
    "export function repKey(user: User): string {",
    "  return requireSalesforceUserId(user);",
    "}",
  ].join("\n");
  eq(
    scanSalesforceUserId(compliant, "src/lib/pet/feed.ts").length,
    0,
    "the compliant shape is clean (the guard is a distinction, not a blanket)",
  );
}
{
  // A comment naming the fallback (this file's own header does) is not code.
  const commented = [
    "// A consumer must never write user.salesforce_user_id ?? user.email here.",
    "const id = requireSalesforceUserId(user);",
  ].join("\n");
  eq(
    scanSalesforceUserId(commented, "src/lib/pet/feed.ts").length,
    0,
    "a comment describing the banned shape is not itself a violation",
  );
}

// --- the two narrowings, each with its own control ---------------------------
//
// Both of these were added because the first version of the guard fired on them,
// and a narrowing with no control is just a weakened guard.
{
  // Naming the ALERT (`salesforce_user_id_conflicts`, `salesforceUserIdConflictAlert`)
  // is not touching the column. Five real files do exactly this and none of them
  // reads a user row.
  const alertOnly = [
    "import { salesforceUserIdConflictAlert } from '@/lib/monitor/cron-alert-copy';",
    "await sendThrottledAlert('salesforce_user_id_conflicts', MS, salesforceUserIdConflictAlert(1, 0, 0));",
  ].join("\n");
  eq(
    scanSalesforceUserId(alertOnly, "src/app/api/cron/agents/route.ts").length,
    0,
    "naming the alert key or its copy builder is not consuming the column",
  );
}
{
  // A test names the column to build a fixture. That is not a consumer.
  const fixture = "store.config.existing = [{ id: 'u1', salesforce_user_id: null }];";
  eq(
    scanSalesforceUserId(fixture, "src/lib/salesforce/sync.test.ts").length,
    0,
    "a test naming the column for a fixture is not an unguarded consumer",
  );
  // But the test exemption is narrow: a test may not DEFEND a fallback, because
  // such a test is the guard for the behaviour this contract removes (L252).
  assert(
    scanSalesforceUserId(
      "expect(user.salesforce_user_id ?? user.email).toBe('a@x.com');",
      "src/lib/salesforce/sync.test.ts",
    ).some((f) => f.kind === "fallback"),
    "a TEST asserting a fallback works is still caught",
  );
}

// --- the writer files are exempt from `unguarded`, and only from that ---------
{
  const real = "src/lib/salesforce/user-id-link.ts";
  const src = readFileSync(join(ROOT, real), "utf8");
  assert(
    src.includes("salesforce_user_id"),
    "the writer control file really does name the column",
  );
  eq(
    scanSalesforceUserId(src, real).length,
    0,
    `${real} is clean (it declares and writes the column)`,
  );
  // The SAME file with a fallback planted in it must still be caught: the
  // exemption covers "does not call the guard", never "may fall back".
  const poisoned = `${src}\nexport const bad = (u: { salesforce_user_id: string | null; email: string }) => u.salesforce_user_id ?? u.email;\n`;
  assert(
    scanSalesforceUserId(poisoned, real).some((f) => f.kind === "fallback"),
    "a fallback planted in a WRITER file is still caught (the exemption is narrow)",
  );
}

// --- the whole src/ tree must be clean ---------------------------------------
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      out.push(rel);
  }
  return out;
}

const surface = walk("src");
assert(surface.length > 100, `the scan surface is populated (${surface.length} files)`);
// Not vacuous: at least one real file must actually name the column, or a
// renamed column would make this whole guard scan nothing and still pass (L98).
const naming = surface.filter((rel) =>
  readFileSync(join(ROOT, rel), "utf8").includes("salesforce_user_id"),
);
assert(
  naming.length >= WRITER_FILES.length,
  `at least ${WRITER_FILES.length} src files name the column, so the guard has something to judge (found ${naming.length})`,
);

for (const rel of surface) {
  for (const f of scanSalesforceUserId(readFileSync(join(ROOT, rel), "utf8"), rel)) {
    assert(
      false,
      f.kind === "fallback"
        ? `${f.file}:${f.line} falls back from the Salesforce User Id to a name or an email, which is the ` +
            `substitution the key exists to remove (L75). Refuse instead: requireSalesforceUserId(user). Line: ${f.text}`
        : `${f.file}:${f.line} reads salesforce_user_id without going through requireSalesforceUserId, so it ` +
            `carries its own idea of what a missing key means. Line: ${f.text}`,
    );
  }
}
assert(true, `${surface.length} src files carry no ungoverned salesforce_user_id read`);

finish();
