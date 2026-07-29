// Repo invariant (#1165): guard against a swallowed-error COUNT result anywhere
// in production `src/`.
//
// The bug class, the count-shaped twin of #277/#315: a PostgREST query asked for
// `{ count: "exact" }` reports a FAILED query as `count: null`, and the
// `count ?? 0` every call site writes turns that failure into a perfectly
// healthy-looking "0 rows". PR #1164 found it in a monitor read; the sweep for
// siblings that filed this issue found three more:
//   - two pool-exit busy_blocks deletes reported `blocksDeleted: 0` on a delete
//     that never ran, so the stale cached busy time the #248 backstop exists to
//     remove lingered with nothing noticing;
//   - the last-admin protection scored a failed read as "zero admins" and
//     refused with "Cannot remove the last admin", a fact it never measured;
//   - the header's pending-time-off badge vanished on a failed read, exactly as
//     it does when the queue is genuinely empty.
//
// Every one of those is the same sentence: an unread count is indistinguishable
// from a real zero. This guard makes a new one fail the build.
//
// A count site is FLAGGED when an awaited Supabase chain (`.from(` present) is
// destructured for `count` WITHOUT also binding `error`, and carries no
// `// error-ok:` opt-out. Unlike the sibling read guard, a WRITE is flagged too:
// `delete({ count: "exact" })` is the headline case, and a delete that silently
// deleted nothing is the whole point.
//
// It is NOT flagged when the site:
//   - also binds `error` (`const { count, error } = ...`, or the aliased
//     `const { error: delErr, count } = ...`), so the caller can consult it;
//   - routes through `unwrapCount` (src/lib/db/result.ts), which throws on a real
//     error and never produces a `{ count }` destructure at all;
//   - is not a Supabase chain (no `.from(`), e.g. `const { count } = await api()`;
//   - carries a `// error-ok:` opt-out on, or in the `//` block directly above,
//     the destructure.
//
// The scan logic lives in scripts/lib/scan-swallowed-error-reads.ts beside its
// read-shaped sibling (they share the destructure, opt-out and builder-resolution
// helpers). This file is the positive control, a real-file mutation control, and
// the whole-`src/` invariant.
// Run: node --experimental-strip-types scripts/test-swallowed-count-results.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanSwallowedCountResults } from "./lib/scan-swallowed-error-reads.ts";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");

// --- positive control: flag the bad shape, allow the safe ones ----------------

interface Fixture {
  name: string;
  flagged: boolean;
  src: string;
}

const FIXTURES: Fixture[] = [
  // FLAGGED: awaited supabase chain destructured for count, error ignored ------
  {
    name: "delete({count}) with the count consumed as rows-affected",
    flagged: true,
    src: `const { count } = await db.from("busy_blocks").delete({ count: "exact" }).eq("user_id", u);\nreturn { blocksDeleted: count ?? 0 };`,
  },
  {
    name: "head:true count feeding a guard",
    flagged: true,
    src: `const { count } = await db.from("users").select("id", { count: "exact", head: true }).in("role", ["admin"]);\nif (!canChangeRole(cur, next, count ?? 0)) throw new Error("x");`,
  },
  {
    name: "builder terminal await, the .from is on an earlier let q line",
    flagged: true,
    src: `let q = supabaseAdmin().from("ooo_requests").select("id", { count: "exact", head: true }).eq("org_id", o);\nq = q.eq("status", "pending");\nconst { count } = await q;\npendingOoo = count ?? 0;`,
  },
  {
    name: "update({count}) reporting rows touched",
    flagged: true,
    src: `const { count } = await db.from("bookings").update({ pii_redacted_at: now }, { count: "exact" }).in("id", ids);\nreturn count ?? 0;`,
  },

  // NOT FLAGGED: error is consulted -------------------------------------------
  {
    name: "count AND error destructured",
    flagged: false,
    src: `const { count, error } = await db.from("bookings").select("id", { count: "exact", head: true });\nif (error) throw error;`,
  },
  {
    name: "aliased error binding first (const { error: delErr, count })",
    flagged: false,
    src: `const { error: delErr, count } = await db.from("booking_outbox").delete({ count: "exact" }).in("id", ids);\nif (delErr) throw delErr;\nreturn count ?? 0;`,
  },
  {
    name: "routed through unwrapCount (no { count } destructure)",
    flagged: false,
    src: `const blocksDeleted = unwrapCount(await db.from("busy_blocks").delete({ count: "exact" }).eq("user_id", u), "pool-exit-prune");\nreturn { blocksDeleted };`,
  },

  // NOT FLAGGED: not a supabase chain -----------------------------------------
  {
    name: "non-supabase await (no .from)",
    flagged: false,
    src: `const { count } = await regalClient.listContacts();\nreturn count;`,
  },
  {
    name: "data-only destructure is the sibling guard's business, not this one",
    flagged: false,
    src: `const { data } = await db.from("bookings").select("id").eq("bucket_id", b);\nreturn (data ?? []).length;`,
  },

  // NOT FLAGGED: documented escape hatch --------------------------------------
  {
    name: "error-ok opt-out on the line above",
    flagged: false,
    src: `// error-ok: best-effort tally; a read error just skips this tick and the next one retries\nconst { count } = await db.from("webhook_deliveries").select("id", { count: "exact", head: true });\nreturn count ?? 0;`,
  },
];

for (const f of FIXTURES) {
  const found = scanSwallowedCountResults(f.src, "fixture").length > 0;
  assert(found === f.flagged, `${f.flagged ? "flags" : "allows"}: ${f.name}`);
}

// --- real-file mutation control ----------------------------------------------
// google/sync.ts is where the headline instance shipped: two busy_blocks deletes
// that reported `blocksDeleted: 0` on a failed delete. They now route through
// unwrapCount. Rewrite them back into the raw `const { count } = await` shape and
// the guard MUST catch it, proving this verifies something against the real code
// and cannot rot into a no-op.
const syncPath = join(ROOT, "src", "lib", "google", "sync.ts");
const syncSrc = readFileSync(syncPath, "utf8");
assert(
  scanSwallowedCountResults(syncSrc, syncPath).length === 0,
  "the real google/sync.ts is clean",
);
const syncReintroduced =
  syncSrc +
  `\nasync function _regression(db: never, userId: string) {\n  const { count } = await db.from("busy_blocks").delete({ count: "exact" }).eq("user_id", userId);\n  return count ?? 0;\n}\n`;
assert(
  scanSwallowedCountResults(syncReintroduced, syncPath).length > 0,
  "positive control: a reintroduced swallowed-error count delete is caught",
);

// --- repo invariant: all of src/ is clean -------------------------------------

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const surface = tsxFiles(join(ROOT, "src"));
assert(surface.length > 0, `found src files to scan (got ${surface.length})`);

let siteCount = 0;
for (const file of surface) {
  const src = readFileSync(file, "utf8");
  const findings = scanSwallowedCountResults(src, file.slice(ROOT.length + 1));
  siteCount += findings.length;
  for (const fnd of findings) {
    assert(
      false,
      `${fnd.file}:${fnd.line} awaited supabase count destructured for \`${fnd.binding}\` without consulting \`error\`; ` +
        `a failed query returns count null, which \`?? 0\` turns into a healthy-looking zero. ` +
        `Route it through unwrapCount (src/lib/db/result.ts), also destructure \`error\` and check it, ` +
        `or annotate // error-ok: <reason> if a zero on error is genuinely safe [${fnd.snippet}]`,
    );
  }
}
if (siteCount === 0) {
  console.log(`ok: no swallowed-error count results across ${surface.length} src files`);
}

finish();
