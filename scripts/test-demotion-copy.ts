// #3615: the ONE sentence that says what a Twilio demotion changed. The audit trail, the Slack
// line and the undo panel all read it, so they can never describe the same change differently
// (L41). Pure, driven here.
import { describeDemotionChange } from "../src/lib/booking/demotion-copy.ts";
import { DEBT_TIER_VALUES, BACKEND_VALUES } from "../src/lib/routing/attribute-vocabulary.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const tiers = (debtTeam: string[], backendService: string[] = []) => ({ debtTeam, backendService });

eq(
  describeDemotionChange({ from: tiers(["ultra_high", "high"]), to: tiers(["high"]) }),
  "Debt tiers went from Ultra High and High to High.",
  "a lost tier names both lists, in human words",
);
eq(
  describeDemotionChange({ from: tiers(["ultra_high", "very_high", "high"]), to: tiers([]) }),
  "Debt tiers went from Ultra High, Very High and High to none.",
  "three or more read as a list, and an empty side reads as none",
);
eq(
  describeDemotionChange({ from: tiers(["high"], ["achieve"]), to: tiers(["high"], ["beyond"]) }),
  "Backend went from Achieve to Beyond.",
  "only what changed is named",
);
eq(
  describeDemotionChange({ from: tiers(["ultra_high", "high"], ["achieve"]), to: tiers(["high"], []) }),
  "Debt tiers went from Ultra High and High to High, and backend went from Achieve to none.",
  "both changes in one sentence",
);
eq(
  describeDemotionChange({ from: tiers(["high", "ultra_high"]), to: tiers(["ultra_high", "high"]) }),
  null,
  "the same set in another order is no change, so there is nothing to say",
);
eq(
  describeDemotionChange({ from: tiers(["platinum"]), to: tiers([]) }),
  "Debt tiers went from platinum to none.",
  "a value the vocabulary does not know is shown as stored rather than dropped",
);
eq(describeDemotionChange(null), null, "an unrecorded change has no sentence; the caller says it was not recorded");

{
  // Every tier and backend the routing vocabulary knows has a human label, so none renders as a key.
  for (const v of [...DEBT_TIER_VALUES, ...BACKEND_VALUES]) {
    const s = describeDemotionChange({ from: tiers([v], [v]), to: tiers([], []) }) ?? "";
    assert(!s.includes(v), `${v} is shown as a word, not its stored key (${s})`);
  }
}

finish();
