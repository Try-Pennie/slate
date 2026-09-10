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
import { DEBT_TIER_VALUES } from "@/lib/routing/attribute-vocabulary";
import {
  readWorker,
  workerSideOrNull,
  LEGAL_ELIGIBLE_YES,
  LEGAL_ELIGIBLE_NO,
  type TwilioSide,
} from "@/lib/twilio/roster";
import { assert, eq, finish } from "./lib/harness.ts";

const MARK = "Y";
/** The clock is injected, so the stamp a flip carries is assertable (L524). */
const NOW = "2026-09-09T12:00:00.000Z";

function row(over: Partial<TwilioRosterRow> = {}): TwilioRosterRow {
  return {
    id: "u1",
    email: "someone@trypennie.com",
    bookable: true,
    deactivated: false,
    pending: false,
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
  const plan = planTwilioRoster([row()], twilio(side(["Redistribute"])), NOW);
  eq(
    plan.flips[0]?.attributes,
    { legal_eligible: LEGAL_ELIGIBLE_NO, redistribute: MARK, redistribute_at: NOW },
    "turning somebody off writes the mark and its stamp, and the legal value rides in the SAME payload rather than a second write over the same column",
  );
  const back = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute: MARK, debt_team: ["low"], legal_eligible: LEGAL_ELIGIBLE_NO } })],
    twilio(side(["Low Debt: 20k - 30k"])),
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
  eq(plan.attributeWrites.length, 1, "it is a write of its own");
  eq(plan.attributeWrites[0]?.changes.legal.value, LEGAL_ELIGIBLE_NO, "and a worker Twilio says nothing about is excluded");
  eq(
    plan.attributeWrites[0]?.attributes,
    { legal_eligible: LEGAL_ELIGIBLE_NO, debt_team: ["low"] },
    "written onto the row's own attributes, alongside the tiers the same tags carry",
  );
}

{
  const plan = planTwilioRoster(
    [row({ attributes: { debt_team: ["low"] } })],
    twilio(side(["Low Debt: 20k - 30k", "Legal Eligible"])),
  );
  eq(plan.attributeWrites[0]?.changes.legal.value, LEGAL_ELIGIBLE_YES, "the positive tag is the only thing that makes somebody eligible");
  eq(
    plan.attributeWrites[0]?.attributes,
    { debt_team: ["low"], legal_eligible: LEGAL_ELIGIBLE_YES },
    "and every other attribute on the row survives the write",
  );
}

{
  // THE CONTROL that keeps this from writing the whole roster every hour. Without
  // it, a planner that emitted a write for everybody would satisfy every assertion
  // above while costing one write per agent per hour forever (L1).
  const plan = planTwilioRoster(
    [row({ attributes: { debt_team: ["low"], legal_eligible: LEGAL_ELIGIBLE_NO } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.attributeWrites.length, 0, "a row already holding what Twilio says is not written again");
}

{
  const plan = planTwilioRoster(
    [row({ attributes: { legal_eligible: LEGAL_ELIGIBLE_YES } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.attributeWrites[0]?.changes.legal.value, LEGAL_ELIGIBLE_NO, "somebody whose positive tag has been taken away is written back to excluded");
}

{
  // The old admin control wrote the BOOLEAN false, which routing reads as neither
  // "N" nor unset, so it excluded nobody while looking like it had (#2120). Nobody
  // carries one, and if anybody did this is what corrects it.
  const plan = planTwilioRoster(
    [row({ attributes: { legal_eligible: false } as never })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.attributeWrites[0]?.changes.legal.value, LEGAL_ELIGIBLE_NO, "a value in no vocabulary is corrected rather than read as already excluded");
}

{
  // Writing N on an absence is deliberate and is the OPPOSITE of what the mark does,
  // so it is reported: this count is also what a partial Twilio read would show up as.
  const plan = planTwilioRoster([row()], new Map());
  eq(plan.withoutWorker, ["someone@trypennie.com"], "a Slate row Twilio holds no worker for is named");
  eq(plan.attributeWrites[0]?.changes.legal.value, LEGAL_ELIGIBLE_NO, "and still written to excluded, because the default is N");
}

{
  const plan = planTwilioRoster(
    [row({ deactivated: true, attributes: {} }), row({ id: "u2", email: "b@trypennie.com", isTest: true, attributes: {} })],
    twilio(side(["Legal Eligible"]), side(["Legal Eligible"], "b@trypennie.com")),
  );
  eq(plan.attributeWrites.length, 0, "a departed agent and a SMOKE test agent are written neither way");
  eq(plan.withoutWorker.length, 0, "and neither is reported as unseen by Twilio");
}

{
  // A worker contradicting itself is held OUT of legal work: offering it to somebody
  // nobody cleared is the harm, and being held back is recoverable.
  const plan = planTwilioRoster([row({ attributes: {} })], twilio(side(["Legal Eligible", "Not Legal Eligible"])));
  eq(plan.attributeWrites[0]?.changes.legal.value, LEGAL_ELIGIBLE_NO, "a worker carrying both legal tags is excluded");
}

// --- the stamp the coverage sweep is keyed on (#2115) --------------------------
// Taking somebody out of the pool strands what they already have booked, so the
// flip enqueues a coverage sweep. That sweep needs an idempotency key the database
// can enforce, and the key is the moment Slate marked them.

{
  const plan = planTwilioRoster([row()], twilio(side(["Redistribute"])), NOW);
  eq(
    (plan.flips[0]?.attributes as Record<string, unknown>).redistribute_at,
    NOW,
    "the mark carries the moment it was made, in the same payload",
  );
  eq(plan.flips[0]?.markedAtIso, NOW, "and the flip names it, so the caller cannot invent a second one");
}

{
  // THE CASE THE KEY EXISTS FOR. A run that died between the mark and the flip
  // leaves a marked and still bookable agent. Next hour plans them again, and it
  // must READ THE STORED STAMP rather than mint a new one: a fresh stamp is a fresh
  // key, so the unique index would never fire and the sweep would run twice.
  const EARLIER = "2026-09-09T10:00:00.000Z";
  const plan = planTwilioRoster(
    [row({ bookable: true, attributes: { redistribute: MARK, redistribute_at: EARLIER } })],
    twilio(side(["Redistribute"])),
    NOW,
  );
  eq(plan.flips[0]?.markedAtIso, EARLIER, "a retry reuses the stamp already stored, so both runs converge on one sweep");
  eq(
    (plan.flips[0]?.attributes as Record<string, unknown>).redistribute_at,
    EARLIER,
    "and writes it back unchanged rather than moving the key under the job",
  );
}

{
  // Coming back off redistribute clears the stamp WITH the mark. A stamp left
  // behind would key a later pool exit onto a months old job, which the unique
  // index would then refuse.
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute: MARK, redistribute_at: NOW, debt_team: ["low"] } })],
    twilio(side(["Low Debt: 20k - 30k"])),
    NOW,
  );
  eq(plan.flips[0]?.action, "turn-back-on", "the agent is put back in the pool");
  const attrs = plan.flips[0]?.attributes as Record<string, unknown>;
  assert(!("redistribute_at" in attrs), "and the stamp goes with the mark, so a later exit gets its own key");
}

{
  // A stamp that is not a stamp cannot key anything, so it is replaced rather than
  // carried into the database as a corrupt key.
  for (const bad of ["", "   ", "not a date"]) {
    const plan = planTwilioRoster(
      [row({ bookable: true, attributes: { redistribute: MARK, redistribute_at: bad } })],
      twilio(side(["Redistribute"])),
      NOW,
    );
    eq(plan.flips[0]?.markedAtIso, NOW, `a stored stamp of ${JSON.stringify(bad)} is replaced rather than used as a key`);
  }
}

{
  // A row needing only a legal write carries no stamp: nothing is being taken out
  // of the pool, so there is no sweep to key.
  const plan = planTwilioRoster([row({ attributes: {} })], twilio(side(["Low Debt: 20k - 30k"])), NOW);
  eq(plan.attributeWrites.length, 1, "the legal write is planned");
  const attrs = plan.attributeWrites[0]?.attributes as Record<string, unknown>;
  assert(!("redistribute_at" in attrs), "and no stamp is invented for somebody who is not leaving the pool");
}

// --- the routing attributes themselves (#2152) ---------------------------------
// Twilio is the source of an agent's debt tiers and backend service, not a second
// opinion about them. Dan, 2026-09-09: "let's use twilio as the source of truth."

{
  const plan = planTwilioRoster(
    [row({ attributes: { role: "Sales", legal_eligible: LEGAL_ELIGIBLE_NO } })],
    twilio(side(["Med Debt: 30k - 50k", "Beyond"])),
  );
  eq(
    plan.attributeWrites[0]?.attributes,
    { role: "Sales", legal_eligible: LEGAL_ELIGIBLE_NO, debt_team: ["medium"], backend_service: ["beyond"] },
    "the tags become the stored routing attributes, and the profile Salesforce owns is left alone",
  );
  eq(plan.attributeWrites[0]?.changes.debtTeams.changed, true, "and the tier change is reported");
  eq(plan.attributeWrites[0]?.changes.backendServices.changed, true, "and so is the backend one");
}

{
  // The direction a mirror exists for and a merge would never do. A tag taken away
  // has to take its value with it, or the agent stays in a pool the source says
  // they are not in, which is the whole failure this issue was opened about.
  const plan = planTwilioRoster(
    [row({ attributes: { debt_team: ["low", "medium"], backend_service: ["achieve"], legal_eligible: LEGAL_ELIGIBLE_NO } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(
    plan.attributeWrites[0]?.attributes,
    { debt_team: ["low"], legal_eligible: LEGAL_ELIGIBLE_NO },
    "a tier and a backend Twilio no longer carries are removed, not merged with",
  );
}

{
  const plan = planTwilioRoster(
    [row({ attributes: { debt_team: ["low"], legal_eligible: LEGAL_ELIGIBLE_NO } })],
    twilio(side(["High Debt: 50k+", "Low Debt: 20k - 30k", "Ultra High Debt: 100k+"])),
  );
  eq(
    (plan.attributeWrites[0]?.attributes as Record<string, unknown>).debt_team,
    ["ultra_high", "high", "low"],
    "the tiers land in the vocabulary's order, highest debt first, whatever order the tags were listed in",
  );
}

{
  // A guard whose expected order came from the thing under test would prove only
  // that it agrees with itself (L70), so the order is checked against the shipped
  // vocabulary rather than restated.
  const plan = planTwilioRoster(
    [row({ attributes: {} })],
    twilio(side(["Low Debt: 20k - 30k", "Med Debt: 30k - 50k", "High Debt: 50k+", "Very High Debt: 70k+", "Ultra High Debt: 100k+"])),
  );
  eq(
    (plan.attributeWrites[0]?.attributes as Record<string, unknown>).debt_team,
    [...DEBT_TIER_VALUES],
    "a worker carrying every tag stores exactly the vocabulary, in its own order",
  );
}

{
  // THE ASYMMETRY, and the reason it is not an oversight. Silence about somebody is
  // not a source saying their tiers are gone (L214), and a partial read that emptied
  // every pool they belong to is not recoverable the way withholding legal work is.
  const plan = planTwilioRoster(
    [row({ attributes: { debt_team: ["low"], backend_service: ["beyond"], legal_eligible: LEGAL_ELIGIBLE_NO } })],
    new Map(),
  );
  eq(plan.attributeWrites.length, 0, "a row Twilio holds no worker for keeps its tiers, so nothing is written");
  eq(plan.withoutWorker, ["someone@trypennie.com"], "and is counted, because doing nothing is otherwise invisible");
}

{
  // A worker that IS present and carries no team tags is an answer, not a silence,
  // so it does clear them.
  const plan = planTwilioRoster(
    [row({ attributes: { debt_team: ["low"], legal_eligible: LEGAL_ELIGIBLE_NO } })],
    twilio(side([])),
  );
  eq(plan.attributeWrites[0]?.attributes, { legal_eligible: LEGAL_ELIGIBLE_NO }, "a worker with no tags at all removes the tiers");
}

{
  // An agent with no tiers has never carried the key, which is what Salesforce
  // wrote and what every reader was written against. Storing an empty array would
  // be a third state nobody handles.
  const plan = planTwilioRoster([row({ attributes: { legal_eligible: LEGAL_ELIGIBLE_NO } })], twilio(side([])));
  eq(plan.attributeWrites.length, 0, "no tiers against no key is not a change, so the whole roster is not rewritten every hour");
}

{
  // The junk the retired admin control could write (#2120). It is not a list, so it
  // must not compare equal to writing nothing.
  const plan = planTwilioRoster(
    [row({ attributes: { debt_team: "low" as never, legal_eligible: LEGAL_ELIGIBLE_NO } })],
    twilio(side([])),
  );
  eq(plan.attributeWrites.length, 1, "a value that is not a list is corrected rather than read as already empty");
  const attrs = plan.attributeWrites[0]?.attributes as Record<string, unknown>;
  assert(!("debt_team" in attrs), "and the key goes");
}

{
  const flip = planTwilioRoster(
    [row({ attributes: { debt_team: ["low"] } })],
    twilio(side(["Redistribute", "Med Debt: 30k - 50k"])),
    NOW,
  );
  eq(
    flip.flips[0]?.attributes,
    { debt_team: ["medium"], legal_eligible: LEGAL_ELIGIBLE_NO, redistribute: MARK, redistribute_at: NOW },
    "a flip's payload carries the tiers too, so the mark and the attributes are never two writes over one column",
  );
  eq(flip.attributeWrites.length, 0, "and the row is not in both lists");
}

// --- the first tier is what makes a new hire bookable (#2071, #2152) -----------
// The transition belongs to whoever WRITES the fact that causes it. Salesforce owns
// the profile; Twilio owns the tier since #2152, so it owns this flip.

{
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { role: "Chatter Free User" } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.attributeWrites[0]?.activate, true, "a hire given their first debt team is put in the pool");
}

{
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { role: "Chatter Free User", debt_team: ["low"] } })],
    twilio(side(["Med Debt: 30k - 50k"])),
  );
  eq(plan.attributeWrites[0]?.activate, false, "changing which tier somebody holds is not a first tier, so nobody is put back in the pool");
}

{
  // THE CASE THE TRANSITION RULE EXISTS FOR (L60). "Has a tier and is not bookable"
  // is exactly the shape of somebody an admin deliberately held back, so a level
  // check would overturn every one of them on the next hourly run.
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { role: "Sales", debt_team: ["low"], legal_eligible: LEGAL_ELIGIBLE_NO } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.attributeWrites.length, 0, "an agent somebody turned off, whose tags still agree, is left alone entirely");
}

{
  const plan = planTwilioRoster(
    [row({ bookable: false, pending: true, attributes: { role: "Chatter Free User" } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.attributeWrites[0]?.activate, false, "a pending row is not activated here: the Salesforce half owns the retry, and two owners means two flips an hour for one intent");
}

{
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { role: "Chatter Free User" } })],
    twilio(side(["Low Debt: 20k - 30k", "Redistribute"])),
  );
  eq(plan.attributeWrites[0]?.activate, false, "somebody Twilio withholds is never put in the pool by their tier");
  eq(plan.flips.length, 0, "and is not flipped either, because they are already out of it");
}

{
  const plan = planTwilioRoster(
    [row({ bookable: true, attributes: { role: "Chatter Free User" } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.attributeWrites[0]?.activate, false, "somebody already in the pool is not activated again");
}

{
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { role: "Sales" } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(
    plan.attributeWrites[0]?.activate,
    false,
    "somebody who already qualified on their Salesforce profile is Salesforce's flip to make, not this one's",
  );
}

finish();
