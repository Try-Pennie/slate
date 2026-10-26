// Repo invariant (#1291): a number Slate REPORTS must not count Slate's own test
// fixtures. Run: node --experimental-strip-types scripts/test-test-data-counts.ts
//
// The bug class, twice in one day. The SMOKE agents and buckets exist to run
// forever (#396), so a monitor that includes them is permanently measuring Slate
// against itself, and nothing fails: the number is simply wrong in a direction
// that reads as healthy. The low-booking-volume count included the canary's
// bookings, where the last 6 hours held 8 bookings and 0 of them were real
// (#1258). The empty-bucket sweep counted the two SMOKE fixtures in the total it
// reported (#1286). In both cases every neighbouring read filtered test rows and
// the new one did not, and the lesson lived only in code comments, which is
// exactly what let the second instance ship (L57).
//
// Both shipped instances are inside this guard's scope, which is the test that
// matters for a new guard: it has to catch the things that actually happened.
//
// The scan logic lives in scripts/lib/scan-test-data-counts.ts so it is
// unit-testable. This file is the positive control, a real-file mutation control,
// and the scoped invariant.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  scanTestDataCounts,
  inReportedCountScope,
  REPORTED_COUNT_SCOPE,
} from "./lib/scan-test-data-counts.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

// --- positive control ---------------------------------------------------------

interface Fixture {
  name: string;
  flagged: boolean;
  code: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "the #1258 shape: a booking count with no test filter",
    flagged: true,
    code: `
      const { count } = await db
        .from("bookings")
        .select("*", { count: "exact", head: true })
        .gte("created_at", sinceIso);
    `,
  },
  {
    name: "the #1286 shape: a bucket total taken from the row count",
    flagged: true,
    code: `
      const buckets = unwrap(await db.from("buckets").select("code"), "buckets");
      const total = buckets.length;
    `,
  },
  {
    name: "a roster count derived with filter()",
    flagged: true,
    code: `
      const rows = unwrap(await db.from("users").select("id, bookable"), "roster");
      const bookable = rows.filter((r) => r.bookable).length;
    `,
  },
  {
    name: "the embed filter, which is how a bookings count excludes test rows",
    flagged: false,
    code: `
      const { count } = await db
        .from("bookings")
        .select("*, buckets!inner(is_test)", { count: "exact", head: true })
        .eq("buckets.is_test", false)
        .gte("created_at", sinceIso);
    `,
  },
  {
    name: "a direct is_test filter",
    flagged: false,
    code: `
      const rows = unwrap(await db.from("buckets").select("code").eq("is_test", false), "b");
      const total = rows.length;
    `,
  },
  {
    name: "the shared real advisor rule (#4201), which keeps test advisors out",
    flagged: false,
    code: `
      const rows = unwrap(
        await realAdvisorsOnly(
          db.from("users").select("id").eq("bookable", true),
        ),
        "roster",
      );
      const total = rows.length;
    `,
  },
  {
    name: "a comment naming the shared rule cannot satisfy the guard",
    flagged: true,
    code: `
      // realAdvisorsOnly( used to wrap this
      const rows = unwrap(await db.from("users").select("id"), "roster");
      const total = rows.length;
    `,
  },
  {
    name: "a primary-key lookup: the set was already chosen upstream",
    flagged: false,
    code: `
      const rows = unwrap(await db.from("users").select("email").in("id", ids), "emails");
      return rows.map((r) => r.email).filter(Boolean);
    `,
  },
  {
    name: "a read nothing aggregates: no number is derived from it",
    flagged: false,
    code: `
      const { data } = await db.from("bookings").select("id, starts_at").single();
      return data;
    `,
  },
  {
    name: "the opt-out, for a number test rows genuinely belong in",
    flagged: false,
    code: `
      // test-data-ok: the PII window applies to the smoke bookings too, so
      // excluding them would leave real contact data unredacted forever.
      const rows = unwrap(await db.from("bookings").select("id").lt("starts_at", cutoff), "pii");
      const due = rows.length;
    `,
  },
  {
    name: "a comment ABOUT a removed filter cannot satisfy the guard",
    flagged: true,
    code: `
      // We used to .eq("is_test", false) here but it was removed.
      const rows = unwrap(await db.from("buckets").select("code"), "b");
      const total = rows.length;
    `,
  },
];

for (const f of FIXTURES) {
  const found = scanTestDataCounts(f.code, f.name).length > 0;
  eq(found, f.flagged, `${f.flagged ? "FLAGS" : "allows"}: ${f.name}`);
}

// --- the scope is what it says, and holds the instances that shipped ----------
{
  assert(inReportedCountScope("src/lib/monitor/customer-bookings.ts"), "the monitor lane is in scope");
  assert(inReportedCountScope("src/lib/availability/service.ts"), "the empty-bucket sweep is in scope");
  assert(!inReportedCountScope("src/lib/salesforce/sync.ts"), "an operational sync is out of scope");
  assert(!inReportedCountScope("src/app/admin/actions.ts"), "an admin action is out of scope");
}

// --- the scoped invariant -----------------------------------------------------

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const scoped = REPORTED_COUNT_SCOPE.flatMap((dir) => tsFiles(join(ROOT, dir))).map((f) =>
  relative(ROOT, f),
);
assert(scoped.length > 20, `the sweep actually found files in scope (${scoped.length})`);

const offenders = scoped.flatMap((file) =>
  scanTestDataCounts(readFileSync(join(ROOT, file), "utf8"), file),
);
eq(
  offenders.map((o) => `${o.file}:${o.line} [${o.table}] ${o.snippet}`),
  [],
  "no reported count in the monitor, alerting or availability surface includes the test fixtures",
);

// --- real-file mutation control ----------------------------------------------
{
  // An empty result reads exactly like a clean codebase whether or not the
  // detector still matches anything (L1). So strip the real filter that #1258 put
  // in, and require it to be caught.
  const file = "src/lib/monitor/customer-bookings.ts";
  const real = readFileSync(join(ROOT, file), "utf8");
  assert(real.includes("is_test"), "sanity: the file this control mutates really does filter test rows");
  // Removes the FILTER while keeping the count, which is the shape the defect
  // actually took. Deleting whole lines would also delete `count: "exact"`, and
  // the guard would then be right to say nothing, so the control would pass for
  // the wrong reason and prove nothing.
  const sabotaged = real
    // Every embed in the file, not only the count's: the per page reads (#2738)
    // carry the same filter, and one left behind would keep `is_test` in the code.
    // Whatever columns the embed names (#2874 added the code, for the tier).
    .replace(/,? ?\$\{BUCKET_EMBED\}|, buckets!inner\([^)]*\)/g, "")
    .replace(/const BUCKET_EMBED = "buckets!inner\([^)]*\)";/, "")
    .split("\n")
    .filter((line) => !line.includes('.eq("buckets.is_test"'))
    .join("\n");
  // Comment lines are checked separately: the file's header mentions `is_test` in
  // prose, and it must NOT be what keeps the guard quiet, which is why the
  // scanner strips comments before matching (L103).
  const sabotagedCode = sabotaged
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, ""))
    .join("\n");
  assert(!sabotagedCode.includes("is_test"), "sanity: the mutation removed every test filter from the CODE");
  assert(
    sabotaged.includes("is_test"),
    "and the prose still mentions it, so this control also proves a comment cannot excuse the read",
  );
  // #2974: the volume count is read as rows and counted in code (`rows.length`), so a
  // development host's booking can be judged by the shared predicate; it is still a
  // count, and the control below proves the scanner still catches THAT read.
  assert(/\brows\.length\b/.test(sabotaged), "sanity: and kept the count, so the read is still a measurement");
  const countFromLine = sabotaged.split("\n").findIndex((l) => l.includes('.from("bookings")')) + 1;
  assert(
    scanTestDataCounts(sabotaged, file).some((f) => f.line === countFromLine),
    "the volume count's own read is among those caught, not only its neighbours",
  );
  assert(
    scanTestDataCounts(sabotaged, file).length > 0,
    "stripping the real test filter IS caught, so the clean sweep means something",
  );
}

finish();
