import { selectWithTierFallback } from "../src/lib/routing/tier-fallback.ts";
import { assert, finish } from "./lib/harness.ts";

async function run() {
  // requested tier has slots: no drop
  let r = await selectWithTierFallback("511", async (c) => (c === "511" ? ["s1"] : []));
  assert(r?.effectiveCode === "511" && r?.rungsDropped === 0, "slots in requested tier => no drop");

  // requested empty, two tiers down has slots
  r = await selectWithTierFallback("511", async (c) => (c === "311" ? ["s1", "s2"] : []));
  assert(r?.effectiveCode === "311" && r?.rungsDropped === 2, "drops two rungs to first tier with slots");

  // a missing bucket (null) is skipped, not treated as available
  r = await selectWithTierFallback("511", async (c) => (c === "411" ? null : c === "311" ? ["s"] : []));
  assert(r?.effectiveCode === "311" && r?.rungsDropped === 2, "null bucket is skipped");

  // nothing anywhere => null
  r = await selectWithTierFallback("511", async () => []);
  assert(r === null, "no availability anywhere => null");

  finish();
}
run();
