// Every monitor, rate and routing analytics read of `bookings` says whether it
// wants ROUTED bookings (#2073).
//
// A booking through an agent's own link sits in a bucket like any other, so a read
// that forgets the kind counts a later call with a lead the funnel already sent as
// a lead the funnel just sent: the low volume alarm holds quiet while customers
// stop arriving, the per page volume reads a page as unsourced, and the bucket
// share ranking pushes the agent down the order for leads they never got through
// the pool. The scan logic is in scripts/lib/scan-routed-booking-reads.ts.
// Run: node --experimental-strip-types scripts/test-routed-booking-reads.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanRoutedBookingReads } from "./lib/scan-routed-booking-reads.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// The surfaces that reason about routed demand. Directories, walked, so a new
// file in any of them is covered by construction (L96).
const SCANNED = [
  "src/lib/monitor",
  "src/lib/admin",
  "src/lib/availability",
  "src/lib/routing",
  "src/app/api/cron/monitor",
  "src/app/admin/routing",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

// --- positive controls: the scan catches the defect and accepts the fixes -------
{
  const unfiltered = `const { count } = await db\n  .from("bookings")\n  .select("id", { count: "exact", head: true })\n  .gte("created_at", since);`;
  eq(scanRoutedBookingReads("f.ts", unfiltered).length, 1, "an unfiltered read of bookings is flagged");
  const filtered = unfiltered.replace(`.gte(`, `.eq("kind", "routed")\n  .gte(`);
  eq(scanRoutedBookingReads("f.ts", filtered).length, 0, "the routed filter in the same statement is accepted");
  const paged = `const rows = await selectAllPages("x", (from, to) =>\n  db\n    .from("bookings")\n    .select("starts_at")\n    .eq("kind", "routed")\n    .range(from, to),\n);`;
  eq(scanRoutedBookingReads("f.ts", paged).length, 0, "a paged callback's chain is read whole");
  const hatched = `// agent-link-ok: a coverage sweep, every real call needs a person\nconst rows = await db.from("bookings").select("id").in("id", ids);`;
  eq(scanRoutedBookingReads("f.ts", hatched).length, 0, "a reasoned hatch is accepted");
  const bare = `// agent-link-ok:\nconst rows = await db.from("bookings").select("id").in("id", ids);`;
  eq(scanRoutedBookingReads("f.ts", bare).length, 1, "a hatch with no reason is not an exemption");
  const other = `await db.from("bookings").select("id").eq("status", "confirmed");\nawait db.from("bookings").select("id").eq("kind", "routed");`;
  eq(scanRoutedBookingReads("f.ts", other).length, 1, "a filter on the NEXT statement does not cover this one");
  const write = `await db.from("bookings").update({ status: "cancelled" }).eq("id", id);`;
  eq(scanRoutedBookingReads("f.ts", write).length, 0, "a write is not a read of demand");
  const commented = `await db\n  .from("bookings")\n  .select("id")\n  // a note; with a semicolon in it\n  .eq("kind", "routed");`;
  eq(scanRoutedBookingReads("f.ts", commented).length, 0, "a semicolon inside a comment does not end the statement");
  const wrongKind =`await db.from("bookings").select("id").eq("kind", "agent_link");`;
  eq(scanRoutedBookingReads("f.ts", wrongKind).length, 1, "a filter on the other kind is not the routed filter");
}

// --- the real tree ---------------------------------------------------------------
{
  const files = SCANNED.flatMap(walk);
  assert(files.length > 20, `the scan read the surfaces it names (${files.length} files)`);
  let reads = 0;
  const findings: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    reads += (src.match(/\.from\(\s*["']bookings["']\s*\)/g) ?? []).length;
    for (const r of scanRoutedBookingReads(f, src)) findings.push(`${r.file}:${r.line}`);
  }
  assert(reads >= 10, `the scan met the bookings reads it exists for (${reads})`);
  eq(findings, [], "every bookings read on these surfaces filters to routed bookings or says why not");
}

// --- a mutation of the real tree is caught ----------------------------------------
{
  const f = "src/lib/monitor/customer-bookings.ts";
  const stripped = readFileSync(f, "utf8").replaceAll(`.eq("kind", "routed")`, "");
  assert(scanRoutedBookingReads(f, stripped).length >= 4, "removing the filters from the low volume counts is caught");
}

finish();
