import { selectWithTierFallback, walkTierLadder } from "../src/lib/routing/tier-fallback.ts";
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

  // walkTierLadder: the shared ladder walk BOTH the display cascade
  // (selectWithTierFallback) and the booking cascade (assignAgentWithTierFallback)
  // are built on, so they can never drift on ladder or rungs-dropped logic (#499).
  let w = await walkTierLadder<string>("511", async (c) => (c === "511" ? { hit: true, value: `pick@${c}` } : { hit: false }));
  assert(w?.effectiveCode === "511" && w?.rungsDropped === 0 && w?.value === "pick@511", "walk: hit on the requested rung, value passed through");

  w = await walkTierLadder<string>("511", async (c) => (c === "311" ? { hit: true, value: c } : { hit: false }));
  assert(w?.effectiveCode === "311" && w?.rungsDropped === 2, "walk: drops to the first hitting rung, rungsDropped = ladder index");

  w = await walkTierLadder<string>("511", async () => ({ hit: false }));
  assert(w === null, "walk: no rung hits => null");

  // An attempt that THROWS must propagate, never be swallowed as a drop. This is
  // what lets the booking cascade rethrow a transient VerifyUnavailable outage
  // instead of masking it as an intentional tier-drop.
  let threw = false;
  try {
    await walkTierLadder<string>("511", async (c) => {
      if (c === "411") throw new Error("verify outage");
      return { hit: false };
    });
  } catch (e) {
    threw = e instanceof Error && e.message === "verify outage";
  }
  assert(threw, "walk: an attempt that throws propagates (a real outage is never masked as a drop)");

  finish();
}
run();
