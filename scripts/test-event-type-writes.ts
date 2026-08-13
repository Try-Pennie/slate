// #1435: an event type cannot be changed without the served copy being refreshed.
//
// Hit live on 2026-08-12. An admin updated an event description, the database was
// correct, the admin screen showed the new text, and the booker went on serving the
// old one, because the event type rides INSIDE the cached `bucket_slots` payload the
// read path serves. Editing the row is not the same as serving it.
//
// Two admin actions happened to remember to invalidate. Nothing enforced it, so the
// next editor added for the name, duration, buffers, notice or cap would have shipped
// the same defect, and a duration change is worse than cosmetic: the org-hours gate
// judges whether a slot FITS the window.
//
// The fix is that invalidation is part of writing (updateEventType). This suite is
// the other direction: nothing else in src/ may write the table. Derived by scanning
// the code, not from a list of call sites, because a registry only checks what
// somebody remembered to add (L96).
//
// Run: node --experimental-strip-types scripts/test-event-type-writes.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { scanEventTypeWrites } from "./lib/scan-event-type-writes.ts";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

/** The one module allowed to write the table: it owns the invalidation. */
const STORE = "src/lib/availability/event-type-store.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// --- the real surface ------------------------------------------------------
{
  const files = walk(SRC)
    .map((f) => ({ rel: relative(ROOT, f).split("\\").join("/"), full: f }))
    .filter((f) => f.rel !== STORE)
    // A test may legitimately fake the chain shape while asserting the store.
    .filter((f) => !/\.test\.tsx?$/.test(f.rel));

  assert(files.length > 100, `scanning ${files.length} source files`);

  const findings = files.flatMap((f) =>
    scanEventTypeWrites(f.rel, readFileSync(f.full, "utf8")),
  );
  eq(
    findings.map((f) => f.message),
    [],
    "no module outside the event-type store writes event_types, so no write can skip the invalidation",
  );
}

// --- the store really exists, and really invalidates ----------------------
// Without this the guard above would pass most cheaply by the store not existing
// at all, and every write having been deleted rather than routed.
{
  const store = readFileSync(join(ROOT, STORE), "utf8");
  assert(/export async function updateEventType/.test(store), "the store exports updateEventType");
  assert(
    /markAllBucketSlotsStale/.test(store),
    "and it calls the invalidation, so writing and refreshing are one operation",
  );
  assert(
    /\.from\(\s*["']event_types["']\s*\)/.test(store),
    "and it is really the module that writes the table",
  );
}

// --- positive controls, or this file could be a no-op (L1) ---------------
{
  const direct = [
    "const { count } = await db",
    '  .from("event_types")',
    "  .update({ description }, { count: \"exact\" })",
    '  .eq("id", id);',
  ].join("\n");
  const caught = scanEventTypeWrites("src/app/admin/actions.ts", direct);
  eq(caught.length, 1, "a direct update on event_types IS caught");
  eq(caught[0]?.method, "update", "and the method is reported");
  assert(
    /reading the OLD value/.test(caught[0]!.message),
    "with a message saying what a lead actually experiences, not just that a pattern matched",
  );

  // A single line chain, which is the shape the scanner would miss if it only
  // looked for a newline between the two calls.
  eq(
    scanEventTypeWrites("x.ts", 'await db.from("event_types").update({ x: 1 }).eq("id", i);').length,
    1,
    "a one-line chain is caught too",
  );

  for (const method of ["upsert", "delete"]) {
    eq(
      scanEventTypeWrites("x.ts", `await db.from("event_types").${method}({ x: 1 });`).length,
      1,
      `a direct .${method} is caught: it changes what is served just as much`,
    );
  }

  // An INSERT is deliberately not flagged: a brand new event type has no cached
  // payload serving an older version of itself.
  eq(
    scanEventTypeWrites("x.ts", 'await db.from("event_types").insert({ name: "Consult" });'),
    [],
    "an insert is not flagged, because there is nothing stale to refresh",
  );

  // A READ is not a write.
  eq(
    scanEventTypeWrites("x.ts", 'await db.from("event_types").select("*").eq("org_id", o);'),
    [],
    "a select is not flagged",
  );

  // Another table's update is none of this guard's business.
  eq(
    scanEventTypeWrites("x.ts", 'await db.from("buckets").update({ x: 1 });'),
    [],
    "a write to a different table is not flagged",
  );

  // And the opt-out really clears it, or the controls above would pass on a
  // scanner that rejects everything.
  const annotated = [
    "// event-type-write-ok: a migration backfill, no Worker is serving yet",
    'await db.from("event_types").update({ x: 1 });',
  ].join("\n");
  eq(scanEventTypeWrites("x.ts", annotated), [], "an annotated write is accepted");
  eq(
    scanEventTypeWrites(
      "x.ts",
      'await db.from("event_types").update({ x: 1 }); // event-type-write-ok: same reason',
    ),
    [],
    "the annotation also works on the line itself",
  );
  // A blank line between the comment and the write breaks the association, so an
  // excuse cannot drift away from what it excuses.
  eq(
    scanEventTypeWrites(
      "x.ts",
      ["// event-type-write-ok: belongs to nothing", "", 'await db.from("event_types").update({});'].join("\n"),
    ).length,
    1,
    "an annotation separated from its write does not excuse it",
  );
}

// --- the runbook's hand-SQL path names the REAL marker key ---------------
// A hand-run SQL edit is outside every code guard, so the runbook carries the two
// steps itself. That only helps if the marker key in the copy-pasteable block is the
// key the code actually reads: a wrong one buys no grace, the bucket_slots_stale page
// arrives anyway, and a reader following the runbook has no way to notice (L41, L32).
{
  const precompute = readFileSync(join(ROOT, "src/lib/availability/precompute.ts"), "utf8");
  const key = /MASS_INVALIDATION_KEY\s*=\s*"([^"]+)"/.exec(precompute)?.[1] ?? "";
  assert(key.length > 0, "the mass-invalidation marker key is readable from the code");

  const runbook = readFileSync(join(ROOT, "docs/migrations-runbook.md"), "utf8");
  const section = runbook.slice(runbook.indexOf("## Changing an event type by hand"));
  assert(section.length > 0, "the runbook documents the hand-SQL path for an event type change");
  assert(
    section.includes(`'${key}'`),
    `the runbook's marker insert uses the real key (${key}), not a placeholder`,
  );
  // Order matters (#1301, L33): staleness with no marker is the false page the
  // marker exists to prevent, so the marker must come first in the block.
  const markerAt = section.indexOf(key);
  const staleAt = section.indexOf("computed_at = 'epoch'");
  assert(staleAt > markerAt && markerAt > 0, "and the marker is written BEFORE the invalidation");
}

finish();
