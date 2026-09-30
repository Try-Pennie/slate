// The outside double-book alert is retired (Dan, 2026-09-30). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-double-book-alert-retired.ts
//
// It paged whenever an advisor put an outside Google event over a Slate call.
// Advisors do that on purpose: a Regal Scheduled Callback is booked over a
// routed call as standard practice, and they are trained not to treat routed
// calls as theirs (managers, #sales thread 2026-09-30). So every page was about
// normal work. This fails if the key, its copy or the sync scan comes back.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALERT_CATALOG } from "@/lib/notify/alert-catalog";
import { assert, finish } from "./lib/harness.ts";

const KEY = "external_double_book";

assert(!ALERT_CATALOG.some((e) => e.key.startsWith(KEY)), `the catalog no longer classifies ${KEY}`);

for (const f of ["src/lib/google/collision.ts", "src/lib/google/collision-alerts.ts"]) {
  assert(!existsSync(f), `${f} is gone`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk("src");
// Positive control: the walk really read the sync module this alert lived in.
assert(files.includes(join("src", "lib", "google", "sync.ts")), "the scan reached src/lib/google/sync.ts");
const offenders = files.filter((f) => /external_double_book|externalDoubleBookAlert|detectExternalCollisions/.test(readFileSync(f, "utf8")));
assert(offenders.length === 0, `nothing in src sends or builds the retired alert (found in: ${offenders.join(", ")})`);

finish();
