// Repo invariant (#354): every PostgREST nested select ("embed") in src/ must be
// backed by a `Relationships` entry in the hand-written Database type
// (src/lib/db/schema.ts), so the embed type-checks instead of forcing an
// `as unknown as` cast (the fragility #354 removed). The #249 round-trip-reducing
// query pattern (`buckets.select("*, event_types(*)")`,
// `availability_schedules.select("...availability_rules(...)")`) is only safe to
// reuse if a new embed can't silently ship without its relationship. A missing
// relationship is invisible in review and in unit tests (a mocked client accepts
// any select string); it only bites against real PostgREST, so assert it here.
//
// Complements src/lib/db/schema.type-test.ts, the compile-time guard that proves
// the two shipped embeds resolve to CONCRETE types; this guard covers EVERY embed,
// including any future one, at the relationship-declared level.
// Run: node --experimental-strip-types scripts/test-db-embed-relationships.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findEmbeds,
  findDeclaredRelationships,
  isEmbedCovered,
  type Embed,
} from "./lib/scan-embed-relationships.ts";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const SCHEMA = join(SRC, "lib", "db", "schema.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const declared = findDeclaredRelationships(readFileSync(SCHEMA, "utf8"));
const embeds: Embed[] = [];
for (const file of sourceFiles(SRC)) {
  const rel = file.slice(ROOT.length + 1);
  for (const e of findEmbeds(readFileSync(file, "utf8"), rel)) embeds.push(e);
}

// Sanity: the scanner must actually find the known-shipped embeds, or a silent
// parser break would let this guard pass by finding nothing (a #708-class false pass).
assert(
  embeds.some((e) => e.table === "buckets" && e.relation === "event_types"),
  "scanner finds the buckets -> event_types embed",
);
assert(
  embeds.some((e) => e.table === "availability_schedules" && e.relation === "availability_rules"),
  "scanner finds the availability_schedules <- availability_rules embed",
);

// The invariant: every embed in src/ is backed by a declared relationship.
for (const e of embeds) {
  assert(
    isEmbedCovered(e, declared),
    `embed ${e.table}.${e.relation}(...) in ${e.file} has a declared Relationship in schema.ts (#354)`,
  );
}

// Positive control: the checker must REJECT an embed whose tables have no
// connecting relationship, so a real regression can't pass unnoticed.
assert(
  !isEmbedCovered({ table: "buckets", relation: "availability_rules" }, declared),
  "positive control: an unrelated embed is reported as uncovered",
);

finish();
