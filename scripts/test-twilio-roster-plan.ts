// Run: node --experimental-strip-types scripts/test-twilio-roster-plan.ts
//
// The decision behind #2097 and #2098: who the roster sync flips out of the bookable
// pool because Twilio says Redistribute, who it flips back in, and what it writes for
// legal eligibility.
//
// Both facts are planned TOGETHER, from one read of the row's attributes, because
// each is a read modify write over the same JSON column. Two planners would each
// build a payload from the same base and the second write would drop the first
// (L443), and the loss is silent: the row still holds a plausible value.
//
// THE ONE THING THIS FILE EXISTS TO PIN. The reverse flip is a TRANSITION, never a
// level (L60). "Twilio does not carry the Redistribute tag" is true of almost the
// whole roster, including every new hire who has no debt team yet and every agent
// an admin turned off by hand, so a plan that flipped everybody untagged ON would
// admit people who were never in the pool and were never withheld. It reads as a
// mirror of Twilio and is actually a mass activation.
//
// So Slate marks the people IT turned off (`attributes.redistribute`), and only a
// marked row can be turned back on. That also settles the alert problem Dan raised
// on the issue: the activation gate refuses an agent with no Google calendar and
// re-alerts every hour, and the four withheld agents who are already not bookable
// (two of them with no calendar row) are never touched by this, because Slate did
// not put them there.
import { planTwilioRoster, isMarkedRedistribute, type TwilioRosterRow } from "@/lib/twilio/roster-plan";
import {
  readWorker,
  workerSideOrNull,
  LEGAL_ELIGIBLE_YES,
  LEGAL_ELIGIBLE_NO,
  type TwilioSide,
} from "@/lib/twilio/roster";
import { assert, eq, finish } from "./lib/harness.ts";

const MARK = "Y";

function row(over: Partial<TwilioRosterRow> = {}): TwilioRosterRow {
  return {
    id: "u1",
    email: "someone@trypennie.com",
    bookable: true,
    deactivated: false,
    isTest: false,
    attributes: {},
    ...over,
  };
}

/** A Twilio side built through the REAL reader, so the tag spelling is the shipped one. */
function side(teams: string[], email = "someone@trypennie.com"): TwilioSide {
  const read = workerSideOrNull(readWorker(JSON.stringify({ email, teams })));
  if (!read) throw new Error("fixture did not read");
  return read;
}
const twilio = (...sides: TwilioSide[]) => new Map(sides.map((s) => [s.email, s]));

// --- turning somebody off -----------------------------------------------------

{
  const plan = planTwilioRoster([row()], twilio(side(["Redistribute", "Low Debt: 20k - 30k"])));
  eq(plan.flips.length, 1, "a bookable agent carrying the tag is flipped");
  eq(plan.flips[0]?.action, "turn-off", "and the direction is out of the pool");
  eq(plan.flips[0]?.userId, "u1", "named by user id, which is what the flip service takes");
}

{
  const plan = planTwilioRoster([row({ bookable: true, attributes: { redistribute: MARK } })], twilio(side(["Redistribute"])));
  eq(plan.flips[0]?.action, "turn-off", "a marked agent somebody turned back on by hand is turned off again: Twilio owns the answer");
}

{
  // The case a naive mirror gets wrong in the safe direction and this one gets right.
  const plan = planTwilioRoster([row({ bookable: false })], twilio(side(["Redistribute"])));
  eq(plan.flips.length, 0, "an agent who is already out of the pool is left alone, not re-flipped");
}

// --- turning somebody back on -------------------------------------------------

{
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute: MARK, debt_team: ["low"] } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.flips.length, 1, "a marked agent whose tag Twilio has dropped is flipped back");
  eq(plan.flips[0]?.action, "turn-back-on", "and the direction is into the pool");
}

{
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute: MARK } })],
    twilio(side(["Redistribute"])),
  );
  eq(plan.flips.length, 0, "a marked agent Twilio still withholds stays out, with nothing written");
}

{
  const plan = planTwilioRoster(
    [row({ bookable: true, attributes: { redistribute: MARK } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.flips[0]?.action, "turn-back-on", "a marked agent already bookable is still planned, so the stale mark gets cleared");
}

// --- the absences, which are not the same as an answer ------------------------

{
  // L214: a source PRESENT but silent about this person is not the same as a tag
  // removed. Flipping them on would be acting on an absence.
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute: MARK } })],
    twilio(side(["Low Debt: 20k - 30k"], "somebody-else@trypennie.com")),
  );
  eq(plan.flips.length, 0, "a marked agent Twilio holds no worker for is NOT flipped back on");
  eq(plan.markedWithNoWorker, ["someone@trypennie.com"], "and is reported, because doing nothing is otherwise invisible");
}

{
  const plan = planTwilioRoster([row({ bookable: true })], new Map());
  eq(plan.flips.length, 0, "an empty Twilio side flips nobody off");
}

{
  // The direction that matters: an empty read must not read as "nobody is tagged
  // any more" and re-admit everybody Slate withheld (L98, L214).
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute: MARK } }), row({ id: "u2", email: "b@trypennie.com", bookable: false, attributes: { redistribute: MARK } })],
    new Map(),
  );
  eq(plan.flips.length, 0, "an empty Twilio side flips nobody back ON either");
  eq(plan.markedWithNoWorker.length, 2, "every marked row is reported instead");
}

// --- who is out of scope entirely --------------------------------------------

{
  const plan = planTwilioRoster(
    [row({ deactivated: true }), row({ id: "u2", email: "b@trypennie.com", deactivated: true, bookable: false, attributes: { redistribute: MARK } })],
    twilio(side(["Redistribute"]), side(["Low Debt: 20k - 30k"], "b@trypennie.com")),
  );
  eq(plan.flips.length, 0, "somebody who has left the pool is flipped neither way");
  eq(plan.markedWithNoWorker.length, 0, "and is not reported as waiting, because they are gone");
}

{
  const plan = planTwilioRoster([row({ isTest: true })], twilio(side(["Redistribute"])));
  eq(plan.flips.length, 0, "the SMOKE test agents are never flipped by a real Twilio tag");
}

{
  const plan = planTwilioRoster([row({ email: "SomeOne@TryPennie.com" })], twilio(side(["Redistribute"])));
  eq(plan.flips.length, 1, "matching is case insensitive on the address, as everywhere else in the roster");
}

// --- the mark itself ----------------------------------------------------------

{
  assert(isMarkedRedistribute({ redistribute: MARK }), "the mark reads as set");
  assert(!isMarkedRedistribute({}), "an absent mark reads as unset");
  assert(!isMarkedRedistribute(null), "so does a row with no attributes at all");
  assert(!isMarkedRedistribute({ redistribute: "N" }), "and an explicit N is not a mark, so a mirror of the tag's absence never becomes one");
}

{
  // The two writes the flip needs, kept beside the plan so the caller cannot
  // invent its own spelling of the mark.
  const plan = planTwilioRoster([row()], twilio(side(["Redistribute"])));
  eq(
    plan.flips[0]?.attributes,
    { legal_eligible: LEGAL_ELIGIBLE_NO, redistribute: MARK },
    "turning somebody off writes the mark, and the legal value rides in the SAME payload rather than a second write over the same column",
  );
  const back = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute: MARK, debt_team: ["low"], legal_eligible: LEGAL_ELIGIBLE_NO } })],
    twilio(side([])),
  );
  eq(
    back.flips[0]?.attributes,
    { debt_team: ["low"], legal_eligible: LEGAL_ELIGIBLE_NO },
    "turning them back on removes it, leaving every other attribute alone",
  );
}

// --- legal eligibility (#2098) -------------------------------------------------
// Dan, 2026-09-09: "The default is N. Y is the only one called out."

{
  const plan = planTwilioRoster([row({ attributes: {} })], twilio(side(["Low Debt: 20k - 30k"])));
  eq(plan.flips.length, 0, "a row needing only a legal value is not a flip");
  eq(plan.legalWrites.length, 1, "it is a write of its own");
  eq(plan.legalWrites[0]?.value, LEGAL_ELIGIBLE_NO, "and a worker Twilio says nothing about is excluded");
  eq(plan.legalWrites[0]?.attributes, { legal_eligible: LEGAL_ELIGIBLE_NO }, "written onto the row's own attributes");
}

{
  const plan = planTwilioRoster(
    [row({ attributes: { debt_team: ["low"] } })],
    twilio(side(["Low Debt: 20k - 30k", "Legal Eligible"])),
  );
  eq(plan.legalWrites[0]?.value, LEGAL_ELIGIBLE_YES, "the positive tag is the only thing that makes somebody eligible");
  eq(
    plan.legalWrites[0]?.attributes,
    { debt_team: ["low"], legal_eligible: LEGAL_ELIGIBLE_YES },
    "and every other attribute on the row survives the write",
  );
}

{
  // THE CONTROL that keeps this from writing the whole roster every hour. Without
  // it, a planner that emitted a write for everybody would satisfy every assertion
  // above while costing one write per agent per hour forever (L1).
  const plan = planTwilioRoster(
    [row({ attributes: { legal_eligible: LEGAL_ELIGIBLE_NO } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.legalWrites.length, 0, "a row already holding what Twilio says is not written again");
}

{
  const plan = planTwilioRoster(
    [row({ attributes: { legal_eligible: LEGAL_ELIGIBLE_YES } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.legalWrites[0]?.value, LEGAL_ELIGIBLE_NO, "somebody whose positive tag has been taken away is written back to excluded");
}

{
  // The old admin control wrote the BOOLEAN false, which routing reads as neither
  // "N" nor unset, so it excluded nobody while looking like it had (#2120). Nobody
  // carries one, and if anybody did this is what corrects it.
  const plan = planTwilioRoster(
    [row({ attributes: { legal_eligible: false } as never })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.legalWrites[0]?.value, LEGAL_ELIGIBLE_NO, "a value in no vocabulary is corrected rather than read as already excluded");
}

{
  // Writing N on an absence is deliberate and is the OPPOSITE of what the mark does,
  // so it is reported: this count is also what a partial Twilio read would show up as.
  const plan = planTwilioRoster([row()], new Map());
  eq(plan.withoutWorker, ["someone@trypennie.com"], "a Slate row Twilio holds no worker for is named");
  eq(plan.legalWrites[0]?.value, LEGAL_ELIGIBLE_NO, "and still written to excluded, because the default is N");
}

{
  const plan = planTwilioRoster(
    [row({ deactivated: true, attributes: {} }), row({ id: "u2", email: "b@trypennie.com", isTest: true, attributes: {} })],
    twilio(side(["Legal Eligible"]), side(["Legal Eligible"], "b@trypennie.com")),
  );
  eq(plan.legalWrites.length, 0, "a departed agent and a SMOKE test agent are written neither way");
  eq(plan.withoutWorker.length, 0, "and neither is reported as unseen by Twilio");
}

{
  // A worker contradicting itself is held OUT of legal work: offering it to somebody
  // nobody cleared is the harm, and being held back is recoverable.
  const plan = planTwilioRoster([row({ attributes: {} })], twilio(side(["Legal Eligible", "Not Legal Eligible"])));
  eq(plan.legalWrites[0]?.value, LEGAL_ELIGIBLE_NO, "a worker carrying both legal tags is excluded");
}

finish();
