// Repo invariant (#2386): exactly ONE module in `src/` decides which columns a
// departure and a return move.
//
// The rule lives in `src/lib/offboarding/lifecycle-write.ts`. Leaving the pool
// stamps `deactivated_at` and clears `bookable` in one statement; returning writes
// `bookable` false, so re-entry to the routing pool goes through the activation
// gate (the calendar probe and the pool entry bootstrap, which live only on the
// bookable flip).
//
// It is a guard rather than a helper because it has already been copied once. #1324
// fixed the offboarding path and wrote the rule down; the hourly Salesforce reap
// kept its own `update({ deactivated_at })` for six weeks, and every leaver it
// processed stayed marked bookable, so every count of the bookable pool overstated
// it and a rehire reactivated later re-entered routing with no calendar read at all.
// A shared constant would not have stopped that: the copy never reached for the
// shared thing (L370). So the next copy fails the build (L613).
//
// The scan lives in scripts/lib/scan-deactivation-writes.ts. This file is the
// positive control, a real-file mutation control, and the whole-`src/` invariant.
// Run: node --experimental-strip-types scripts/test-deactivation-write.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { scanDeactivationWrites } from "./lib/scan-deactivation-writes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");
const OWNER = "src/lib/offboarding/lifecycle-write.ts";

// --- positive control: the shape it must catch, and the ones it must not -------

interface Fixture {
  name: string;
  flagged: boolean;
  src: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "the reap's own bulk departure, the #2386 defect itself",
    flagged: true,
    src: `await db.from("users").update({ deactivated_at: new Date().toISOString() }).in("id", ids);`,
  },
  {
    name: "a departure that DOES clear bookable is still a second copy of the rule",
    flagged: true,
    src: `await db.from("users").update({ deactivated_at: stamp, bookable: false }).eq("id", id);`,
  },
  {
    name: "a multi-line patch object",
    flagged: true,
    src: [
      `await db.from("users").update({`,
      `  deactivated_at: null,`,
      `}).eq("id", id);`,
    ].join("\n"),
  },
  {
    name: "one hop through a local const, which is the shape the rule's own writer uses",
    flagged: true,
    src: [
      `const patch = { deactivated_at: stamp };`,
      `await db.from("users").update(patch).eq("id", id);`,
    ].join("\n"),
  },
  {
    name: "one hop onto a patch built by the shared module is not a second copy",
    flagged: false,
    src: [
      `const patch = plan.deactivate ? deactivationPatch(stamp) : reactivationPatch();`,
      `await db.from("users").update(patch).eq("id", id);`,
    ].join("\n"),
  },
  {
    name: "a write of some other column",
    flagged: false,
    src: `await db.from("users").update({ role: "manager" }).in("id", ids);`,
  },
  {
    name: "a READ that merely selects the column",
    flagged: false,
    src: `const r = await db.from("users").select("id, deactivated_at").eq("id", id);`,
  },
  {
    name: "an unrelated table whose patch happens to sit near the word",
    flagged: false,
    src: `await db.from("ooo_requests").update({ status: "approved" }).eq("id", id);\n// deactivated_at is read elsewhere`,
  },
  {
    name: "the escape hatch, carrying a reason",
    flagged: false,
    src: [
      `// lifecycle-write-ok: a one-off correction that must not touch bookable`,
      `await db.from("users").update({ deactivated_at: null }).eq("id", id);`,
    ].join("\n"),
  },
  {
    name: "the escape hatch with no reason is refused",
    flagged: true,
    src: [
      `// lifecycle-write-ok:`,
      `await db.from("users").update({ deactivated_at: null }).eq("id", id);`,
    ].join("\n"),
  },
];

for (const f of FIXTURES) {
  const hits = scanDeactivationWrites("fixture.ts", f.src);
  eq(hits.length > 0, f.flagged, `fixture: ${f.name}`);
}

// --- the whole-src invariant ---------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(join(ROOT, "src"));
assert(files.length > 100, `scanned the real src tree (${files.length} files)`);

const violations = files.flatMap((full) => {
  const rel = relative(ROOT, full);
  if (rel === OWNER) return [];
  return scanDeactivationWrites(rel, readFileSync(full, "utf8"));
});
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.text}`);
}
eq(violations.length, 0, "no deactivated_at write in src/ outside the owning module");

// --- mutation control over the REAL tree ---------------------------------------
//
// A scanner that reads a clean tree and a scanner that reads nothing produce the
// same empty list (L98). So the reap's write is put back as it was, in memory, and
// the guard must catch it and blame the right file.

const REAP = "src/lib/salesforce/sync.ts";
const reapSource = readFileSync(join(ROOT, REAP), "utf8");
assert(
  reapSource.includes("deactivateUsersByIds("),
  "the reap still routes its departure through the shared write",
);
const reverted = reapSource.replace(
  "await deactivateUsersByIds(toDeactivate, new Date().toISOString());",
  `await db.from("users").update({ deactivated_at: new Date().toISOString() }).in("id", toDeactivate);`,
);
assert(reverted !== reapSource, "the revert overlay actually changed the source");
const caught = scanDeactivationWrites(REAP, reverted);
eq(caught.length, 1, "reverting the reap's write is caught");
eq(caught[0]?.file, REAP, "and is blamed on the reap, not on the owning module");

// The owning module must itself carry the rule, or the exemption above would be
// exempting a file that decides nothing, and the invariant would read as held
// while every caller was free again.
const ownerSource = readFileSync(join(ROOT, OWNER), "utf8");
assert(
  /export function deactivationPatch\(/.test(ownerSource) &&
    /export function reactivationPatch\(/.test(ownerSource) &&
    /export async function deactivateUsersByIds\(/.test(ownerSource),
  "the owning module still exports both patches and the bulk write",
);
// BOTH directions, asserted separately: a departure that left the flag is the
// original defect, and a return that left it is #2386's own half.
eq(
  /deactivated_at: stampIso,\s*bookable: false/.test(ownerSource),
  true,
  "departing clears bookable in the same patch that stamps the departure",
);
eq(
  /deactivated_at: null,\s*bookable: false/.test(ownerSource),
  true,
  "returning writes bookable false, so re-entry passes the activation gate",
);

finish();
