// Every Durable Object Slate looks up is created beside the Worker (#3752,
// `src/lib/object-placement.ts`). A lookup with no hint creates its object wherever its
// first request lands and keeps it there; the per address rate counters were the case,
// and their first call was the largest part of a cold confirm in load runs 28 and 32.
//
// Run: node --experimental-strip-types scripts/test-object-location-hint.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { objectLookups } from "./lib/scan-object-location-hint.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, acc);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(path);
  }
  return acc;
}

// Controls: the scan sees each shape it must judge.
{
  const bare = objectLookups("f.ts", "const stub = ns.get(ns.idFromName(key));");
  eq(bare.unhinted.length, 1, "control: a lookup with no hint is flagged");
  const literal = objectLookups("f.ts", 'const stub = ns.get(ns.idFromName(key), { locationHint: "wnam" });');
  eq(literal.unhinted.length, 1, "control: a literal region is flagged, so the place lives in one constant");
  const hinted = objectLookups("f.ts", "const stub = ns.get(ns.idFromName(name(a, b)), { locationHint: OBJECT_LOCATION_HINT });");
  eq(hinted.hinted, 1, "control: the shared hint passes, nested calls and all");
  eq(hinted.unhinted.length, 0, "control: and is not flagged");
  const multi = objectLookups("f.ts", "const stub = namespace.get(\n  namespace.idFromString(id),\n);");
  eq(multi.unhinted.length, 1, "control: a lookup over several lines, by string id, is flagged");
  const hoisted = objectLookups("f.ts", "const id = ns.idFromName(key);\nconst stub = ns.get(id);");
  eq(hoisted.unhinted.length, 1, "control: a lookup whose id was made a line earlier is flagged");
  const hoistedHinted = objectLookups("f.ts", "const id = ns.idFromName(key);\nconst stub = ns.get(id, { locationHint: OBJECT_LOCATION_HINT });");
  eq(hoistedHinted.hinted, 1, "control: and passes once it carries the hint");
  const asserted = objectLookups("f.ts", "const stub = env.X!.get(env.X!.idFromName(key));");
  eq(asserted.unhinted.length, 1, "control: a lookup through a non null assertion is flagged");
  const optional = objectLookups("f.ts", "const stub = env.X?.get(env.X?.idFromName(key));");
  eq(optional.unhinted.length, 1, "control: a lookup through optional chaining is flagged");
  const unique = objectLookups("f.ts", "const stub = ns.get(ns.newUniqueId());");
  eq(unique.unhinted.length, 1, "control: a lookup by a new unique id is flagged");
  const unrelated = objectLookups("f.ts", "const v = map.get(id);\nconst h = headers.get(\"x\");");
  eq(unrelated.hinted + unrelated.unhinted.length, 0, "control: a Map or Headers get is not a lookup");
  const prose = objectLookups("f.ts", "// ns.get(ns.idFromName(key)) is how a stub is made\nconst x = 1;");
  eq(prose.hinted + prose.unhinted.length, 0, "control: a lookup in a comment is not a lookup");
}

// The real tree.
let hinted = 0;
const unhinted: { file: string; line: number; text: string }[] = [];
for (const dir of ["src", "worker"]) {
  for (const path of sources(join(ROOT, dir))) {
    const found = objectLookups(relative(ROOT, path), readFileSync(path, "utf8"));
    hinted += found.hinted;
    unhinted.push(...found.unhinted);
  }
}
for (const u of unhinted) console.error(`  ${u.file}:${u.line}  ${u.text}`);
eq(unhinted.length, 0, "every Durable Object lookup in src/ and worker/ passes OBJECT_LOCATION_HINT");
// Five lookups when this was written: the two rate counters, the burst counter's proof,
// the confirm line and the token holder. Fewer means the scan stopped seeing them (L98).
assert(hinted >= 5, `the scan found the lookups it guards (${hinted} hinted)`);

finish();
