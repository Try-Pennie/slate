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

  // --- the Beyond overflow, through the DISPLAY cascade (#1909) ---
  //
  // The Low plus Beyond hole is the case the rule was written for: 120, 121 and
  // 122 have zero eligible agents and no tier beneath them, so before the
  // overflow rung a lead on 122 was shown nothing at all.
  r = await selectWithTierFallback("122", async (c) => (c === "132" ? ["s1"] : []));
  assert(
    r?.effectiveCode === "132" && r?.rungsDropped === 1,
    `122 reaches Achieve in its own tier (got ${r?.effectiveCode})`,
  );

  // The requested Beyond bucket still wins when it has anything at all: the
  // overflow is a fallback, never a preference.
  r = await selectWithTierFallback("522", async (c) => (c === "522" || c === "532" ? ["s"] : []));
  assert(r?.effectiveCode === "522" && r?.rungsDropped === 0, "a staffed Beyond bucket is not overflowed");

  // Same tier Achieve is tried BEFORE the tier below, in both backends.
  r = await selectWithTierFallback("522", async (c) => (c === "532" || c === "422" ? ["s"] : []));
  assert(r?.effectiveCode === "532", `the same tier Achieve rung comes first (got ${r?.effectiveCode})`);

  // --- the BOOKING cascade, on the case #2486 changed ---
  //
  // Beyond and Achieve both dry at the requested tier. Before #2486 this dropped
  // a debt tier and booked `422`; now the tier's WHOLE pool is asked first, so
  // the lead keeps the debt tier they asked for and books `512`. Re-derived from
  // the new ladder rather than adjusted, because the decision it encoded was
  // deliberately reversed (L430): offering a lower debt tier while somebody in
  // the requested tier had not been asked is the defect #2486 was opened about.
  const crossTier = await walkTierLadder<string>("522", async (c) =>
    c === "522" || c === "532" ? { hit: false } : { hit: true, value: c },
  );
  assert(
    crossTier?.effectiveCode === "512",
    `a dry backend crosses to the tier's whole pool (got ${crossTier?.effectiveCode})`,
  );
  assert(crossTier?.rungsDropped === 2, `two rungs were walked (got ${crossTier?.rungsDropped})`);
  assert(
    Number("522"[0]) - Number(crossTier!.effectiveCode[0]) === 0,
    "and NO debt tier was dropped, which is the whole point of #2486",
  );

  // The tier is still dropped once it is genuinely exhausted, so the widening
  // cannot have turned the tier drop off. Both directions, or the assertion
  // above is satisfied by a ladder that never drops a tier at all (L1).
  const dryTier = await walkTierLadder<string>("522", async (c) =>
    c === "522" || c === "532" || c === "512" ? { hit: false } : { hit: true, value: c },
  );
  assert(
    dryTier?.effectiveCode === "422",
    `an exhausted tier still drops to the next one (got ${dryTier?.effectiveCode})`,
  );
  assert(dryTier?.rungsDropped === 3, `three rungs were walked (got ${dryTier?.rungsDropped})`);
  assert(
    Number("522"[0]) - Number(dryTier!.effectiveCode[0]) === 1,
    "and exactly one debt tier was dropped, which is what the alert says",
  );

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
