// #2388: no PostgREST `in` filter is fed from a list that is unbounded by
// construction.
//
// The defect shipped on four retention lanes and on the monitor lane's OOO coverage
// check, and its symptom is the worst kind: a scheduled lane whose request is REFUSED
// at the transport destroys nothing, meets the same candidates the next night, and
// stays broken until somebody reads a log. The retention gate then keeps the export
// frozen behind it.
//
// The scan and the reasons behind it live in scripts/lib/scan-unchunked-in-filters.ts.
// This drives it over the real tree AND over fixtures, including the ones that prove
// it still catches the bad pattern: a scanner blind to a shape and a clean tree
// produce the same empty result (L98).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  scanUnchunkedInFilters,
  everyPageReaders,
  type ScanInput,
} from "./lib/scan-unchunked-in-filters.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const real: ScanInput[] = files.map((file) => ({ file, source: readFileSync(file, "utf8") }));

assert(real.length > 100, `the scan read the real tree (${real.length} files)`);

// --- the derivation that keeps the reader list honest ---
{
  const readers = everyPageReaders(real);
  assert(readers.size > 0, `derived ${readers.size} every page readers from the tree rather than listing them`);
  assert(
    readers.has("loadOooCoverageBookings"),
    "it finds a reader that returns selectAllPages directly",
  );
  assert(
    !readers.has("bookableSlotReason"),
    "and does not claim a function that never pages",
  );
}

// --- the real tree is clean ---
{
  const findings = scanUnchunkedInFilters(real);
  for (const f of findings) {
    console.error(
      `FAIL: ${f.file}:${f.line} feeds an in filter from the unbounded ${f.source}` +
        (f.unreasoned ? " (its in-chunk-ok carries no reason)" : "") +
        `\n      ${f.snippet}`,
    );
  }
  eq(findings.length, 0, "no in filter in src/ is fed from an unbounded read");
}

// --- POSITIVE CONTROL against the REAL file, so the guard cannot rot into a no-op ---
// The monitor lane's stranded coverage read, put back the way it shipped: `items`
// comes from selectAllPages in the same function, and every booking id went into one
// filter. The overlay replaces the file's content in memory; nothing is written.
{
  const target = files.find((f) => f.endsWith("app/api/cron/monitor/route.ts"));
  assert(target !== undefined, "the monitor route is in the scanned set");
  const overlay = real.map((input) =>
    input.file === target
      ? {
          file: input.file,
          source: input.source.replace(
            /const bookingPages = await inIdChunks\([\s\S]*?\n {6}\);/,
            [
              "const bookings = (unwrap(",
              "        await db",
              '          .from("bookings")',
              '          .select("id")',
              '          .in("id", items.map((it) => it.booking_id))',
              '          .in("status", ACTIVE_BOOKING_STATUSES),',
              '        "monitor stranded coverage bookings",',
              "      ) ?? []) as { id: string }[];",
            ].join("\n"),
          ),
        }
      : input,
  );
  const changed = overlay.find((o) => o.file === target)!.source;
  assert(
    changed.includes('.in("id", items.map((it) => it.booking_id))'),
    "the overlay really did reintroduce the unchunked filter (a failed substitution would make the control vacuous)",
  );
  const findings = scanUnchunkedInFilters(overlay);
  const caught = findings.filter((f) => f.file === target);
  if (caught.length !== 1) {
    for (const c of caught) console.error(`   control caught ${c.file}:${c.line} from ${c.source}: ${c.snippet}`);
  }
  eq(caught.length, 1, "the guard catches the real defect put back into the real file");
  eq(caught[0]?.source, "items", "and names the unbounded list it came from");
}

// --- fixtures: each way the shape can appear, and each way it can be compliant ---
const fx = (source: string, file = "fixture.ts"): ScanInput[] => [{ file, source }];

{
  const bad = `
    const rows = await selectAllPages<Row>("x", "id", () => q);
    const res = await db.from("t").select("id").in("id", rows.map((r) => r.id));
  `;
  eq(scanUnchunkedInFilters(fx(bad)).length, 1, "a paginated read feeding an in filter is caught");
}

{
  // The same list one alias further away, which is how it actually reads in the wild.
  const bad = `
    const rows = await selectAllPages<Row>("x", "id", () => q);
    const ids = rows.map((r) => r.id);
    const res = await db.from("t").select("id").in("id", ids);
  `;
  eq(scanUnchunkedInFilters(fx(bad)).length, 1, "it follows the list through an alias");
}

{
  const bad = `
    const rows = await selectAllPages<Row>("x", "id", () => q);
    const ids = [...new Set(rows.map((r) => r.user_id))];
    const res = await db.from("t").select("id").in("id", ids);
  `;
  eq(scanUnchunkedInFilters(fx(bad)).length, 1, "and through a deduplicating spread");
}

{
  // The chain broken over several lines, which no single line regex could read.
  const bad = `
    const rows = await selectAllPages<Row>("x", "id", () => q);
    const res = await db
      .from("t")
      .select("id")
      .in(
        "id",
        rows.map((r) => r.id),
      );
  `;
  eq(scanUnchunkedInFilters(fx(bad)).length, 1, "a filter split across lines is caught too");
}

{
  // The cross file case: a reader in one file, the filter in another.
  const inputs: ScanInput[] = [
    {
      file: "reader.ts",
      source: `export async function loadEverything() {
        return selectAllPages<Row>("x", "id", () => q);
      }`,
    },
    {
      file: "caller.ts",
      source: `const rows = await loadEverything();
        const res = await db.from("t").select("id").in("id", rows.map((r) => r.id));`,
    },
  ];
  const findings = scanUnchunkedInFilters(inputs);
  eq(findings.length, 1, "a list obtained from a paginating reader in ANOTHER file is caught");
  eq(findings[0]?.file, "caller.ts", "and is blamed on the file holding the filter");
}

{
  const good = `
    const rows = await selectAllPages<Row>("x", "id", () => q);
    for (const chunk of chunkIdsByUrlBudget(rows.map((r) => r.id))) {
      await db.from("t").delete().in("id", chunk);
    }
  `;
  eq(scanUnchunkedInFilters(fx(good)).length, 0, "a chunkIdsByUrlBudget loop is the compliant form");
}

{
  const good = `
    const rows = await selectAllPages<Row>("x", "id", () => q);
    await inIdChunks("label", rows.map((r) => r.id), async (batch) => {
      return db.from("t").select("id").in("id", batch);
    });
  `;
  eq(scanUnchunkedInFilters(fx(good)).length, 0, "and so is an inIdChunks callback");
}

{
  const good = `
    const rows = await selectAllPages<Row>("x", "id", () => q);
    const res = await db.from("t").select("id").in("status", ["confirmed", "rescheduled"]);
  `;
  eq(
    scanUnchunkedInFilters(fx(good)).length,
    0,
    "a vocabulary filter beside an unbounded read is not flagged",
  );
}

{
  const good = `
    const rows = await db.from("t").select("id").limit(50);
    const res = await db.from("u").select("id").in("id", rows.map((r) => r.id));
  `;
  eq(scanUnchunkedInFilters(fx(good)).length, 0, "a bounded read is not flagged");
}

{
  // The escape hatch, and the refusal of one that says nothing (L675).
  const excused = `
    const rows = await selectAllPages<Row>("x", "id", () => q);
    // in-chunk-ok: rows is one org's buckets, capped at sixty by the routing matrix
    const res = await db.from("t").select("id").in("id", rows.map((r) => r.id));
  `;
  eq(scanUnchunkedInFilters(fx(excused)).length, 0, "a reasoned in-chunk-ok excuses the site");

  const empty = `
    const rows = await selectAllPages<Row>("x", "id", () => q);
    // in-chunk-ok:
    const res = await db.from("t").select("id").in("id", rows.map((r) => r.id));
  `;
  const findings = scanUnchunkedInFilters(fx(empty));
  eq(findings.length, 1, "an in-chunk-ok with no reason does NOT excuse it");
  eq(findings[0]?.unreasoned, true, "and is reported as an unreasoned hatch, not a plain finding");
}

{
  // Comments stripped before matching, so prose ABOUT the pattern neither trips the
  // guard nor satisfies it (L103).
  const prose = `
    // A note about .in("id", rows.map((r) => r.id)) and why it would be wrong.
    const rows = await selectAllPages<Row>("x", "id", () => q);
  `;
  eq(scanUnchunkedInFilters(fx(prose)).length, 0, "prose naming the bad pattern is not a finding");
}

finish();
