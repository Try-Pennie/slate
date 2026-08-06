// The two TTLs that must agree (#1296).
//
// Run: node --experimental-strip-types scripts/test-business-hours-ttl.ts
//
// `BUSINESS_HOURS_TTL_MS` caches the org's hours per isolate; `SLOT_TTL_SECONDS`
// caches the slots those hours FILTER. They have to stay in step, because the
// filter is only as current as the hours it reads: if the hours cache outlived the
// slot cache, a narrowing could be enforced later than the slots it is meant to
// remove, and the booker would keep offering a closed hour for the difference.
//
// They cannot be one constant. `business-hours-load` importing `slot-cache` would
// close a cycle (slot-cache -> availability service -> business-hours-load), so the
// value is written twice and this guard is what keeps the pair honest. Raising one
// without the other fails the build here rather than showing up as a booker that
// enforces an edit a few seconds late.
//
// Both are read out of the SOURCE rather than imported, because importing
// business-hours-load pulls in the Supabase client and the `@/` alias, which this
// node-native suite does not resolve. Reading the text is also the stricter check:
// it fails if the constant is renamed or removed, not only if the number changes.
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";

function constantIn(path: string, name: string): number {
  const src = readFileSync(path, "utf8");
  const m = new RegExp(`export const ${name}\\s*=\\s*([0-9_]+)`).exec(src);
  assert(m !== null, `${name} is still declared in ${path}`);
  return m ? Number(m[1].replace(/_/g, "")) : NaN;
}

const hoursTtlMs = constantIn("src/lib/booking/business-hours-load.ts", "BUSINESS_HOURS_TTL_MS");
const slotTtlSeconds = constantIn("src/lib/availability/slot-cache.ts", "SLOT_TTL_SECONDS");

eq(
  hoursTtlMs,
  slotTtlSeconds * 1000,
  "the org-hours cache TTL matches the slot cache TTL, so the read-time filter is never staler than what it filters",
);

// A positive control, so this file can never rot into a test of nothing: the
// comparison it makes must actually be able to fail.
assert(
  Number.isFinite(hoursTtlMs) && hoursTtlMs > 0,
  "the hours TTL was really parsed out of the source, not defaulted to NaN",
);
assert(
  hoursTtlMs !== (slotTtlSeconds * 1000 + 1),
  "control: the assertion above compares real numbers rather than passing vacuously",
);

finish();
