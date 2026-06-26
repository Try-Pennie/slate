import { routingMetaFromTrace } from "../src/lib/webhooks/types.ts";
import type { RoutingTrace } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}

const plain: RoutingTrace = {
  bucket_code: "500", bucket_id: "b", considered: ["a"], chosen_user_id: "a",
  fallback_applied: false,
};
let m = routingMetaFromTrace(plain);
assert(m.tier_fallback === false, "plain trace => tier_fallback false");
assert(m.empty_pool_fallback === false, "plain trace => empty_pool_fallback false");
assert(m.rungs_dropped === 0, "plain trace => rungs_dropped 0");

const dropped: RoutingTrace = {
  bucket_code: "500", bucket_id: "b", considered: ["v"], chosen_user_id: "v",
  fallback_applied: false, tier_fallback: true, requested_tier: "ultra_high",
  booked_tier: "very_high", rungs_dropped: 1,
};
m = routingMetaFromTrace(dropped);
assert(m.tier_fallback === true, "tier-drop trace => tier_fallback true");
assert(m.requested_tier === "ultra_high" && m.booked_tier === "very_high", "tiers carried");
assert(m.rungs_dropped === 1, "rungs carried");

const emptyPool: RoutingTrace = {
  bucket_code: "500", bucket_id: "b", considered: ["f"], chosen_user_id: "f",
  fallback_applied: true,
};
assert(routingMetaFromTrace(emptyPool).empty_pool_fallback === true, "empty-pool flag carried");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
