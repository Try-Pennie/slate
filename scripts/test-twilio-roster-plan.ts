// Run: node --experimental-strip-types scripts/test-twilio-roster-plan.ts
//
// The decision behind #2097 and #2098: who the roster sync flips out of the bookable
// pool because Twilio says Redistribute, who it flips back in, and what it writes for
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
import {
  planTwilioRoster,
  isMarkedRedistribute,
  carriesRedistributeTag,
  type TwilioRosterRow,
} from "@/lib/twilio/roster-plan";
import { DEBT_TIER_VALUES } from "@/lib/routing/attribute-vocabulary";
import {
  readWorker,
  workerSideOrNull,
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
    { redistribute_tagged: MARK, redistribute: MARK, redistribute_at: NOW },
    "turning somebody off writes the mark and its stamp, beside the mirrored tag",
  );
  const back = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute: MARK, debt_team: ["low"] } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(
    back.flips[0]?.attributes,
    { debt_team: ["low"] },
    "turning them back on removes it, leaving every other attribute alone",
  );
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
  // A row needing only an attribute write carries no stamp: nothing is being taken out
  // of the pool, so there is no sweep to key.
  const plan = planTwilioRoster([row({ attributes: {} })], twilio(side(["Low Debt: 20k - 30k"])), NOW);
  eq(plan.attributeWrites.length, 1, "the attribute write is planned");
  const attrs = plan.attributeWrites[0]?.attributes as Record<string, unknown>;
  assert(!("redistribute_at" in attrs), "and no stamp is invented for somebody who is not leaving the pool");
}

// --- the routing attributes themselves (#2152) ---------------------------------
// Twilio is the source of an agent's debt tiers and backend service, not a second
// opinion about them. Dan, 2026-09-09: "let's use twilio as the source of truth."

{
  const plan = planTwilioRoster(
    [row({ attributes: { role: "Sales" } })],
    twilio(side(["Med Debt: 30k - 50k", "Beyond"])),
  );
  eq(
    plan.attributeWrites[0]?.attributes,
    { role: "Sales", debt_team: ["medium"], backend_service: ["beyond"] },
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
    [row({ attributes: { debt_team: ["low", "medium"], backend_service: ["achieve"] } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(
    plan.attributeWrites[0]?.attributes,
    { debt_team: ["low"] },
    "a tier and a backend Twilio no longer carries are removed, not merged with",
  );
}

{
  const plan = planTwilioRoster(
    [row({ attributes: { debt_team: ["low"] } })],
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
  // every pool they belong to is not recoverable.
  const plan = planTwilioRoster(
    [row({ attributes: { debt_team: ["low"], backend_service: ["beyond"] } })],
    new Map(),
  );
  eq(plan.attributeWrites.length, 0, "a row Twilio holds no worker for keeps its tiers, so nothing is written");
  eq(plan.withoutWorker, ["someone@trypennie.com"], "and is counted, because doing nothing is otherwise invisible");
}

{
  // A worker that IS present and carries no team tags is an answer, not a silence,
  // so it does clear them.
  const plan = planTwilioRoster(
    [row({ attributes: { debt_team: ["low"] } })],
    twilio(side([])),
  );
  eq(plan.attributeWrites[0]?.attributes, {}, "a worker with no tags at all removes the tiers");
}

{
  // An agent with no tiers has never carried the key, which is what Salesforce
  // wrote and what every reader was written against. Storing an empty array would
  // be a third state nobody handles.
  const plan = planTwilioRoster([row({ attributes: {} })], twilio(side([])));
  eq(plan.attributeWrites.length, 0, "no tiers against no key is not a change, so the whole roster is not rewritten every hour");
}

{
  // The junk the retired admin control could write (#2120). It is not a list, so it
  // must not compare equal to writing nothing.
  const plan = planTwilioRoster(
    [row({ attributes: { debt_team: "low" as never } })],
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
    { debt_team: ["medium"], redistribute_tagged: MARK, redistribute: MARK, redistribute_at: NOW },
    "a flip's payload carries the tiers too, so the mark and the attributes are never two writes over one column",
  );
  eq(flip.attributeWrites.length, 0, "and the row is not in both lists");
}

// --- the planner never puts anybody in the pool (#2182) ------------------------
// It used to, when a first Twilio tier arrived. Dan's call, 2026-09-10: becoming
// bookable stays a Salesforce decision, because a tag here says what somebody can
// be ROUTED FOR and never that they are taking calls.

{
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { role: "Chatter Free User" } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.attributeWrites.length, 1, "a hire's first debt team is still written");
  eq(plan.flips.length, 0, "and flips nobody into the pool");
  assert(
    !("activate" in (plan.attributeWrites[0] as object)),
    "the write carries no activation at all, so no caller can act on one",
  );
}

{
  // The whole roster equivalent: nothing here ever produces a flip except the two
  // the Redistribute tag demands.
  const plan = planTwilioRoster(
    [
      row({ id: "u1", email: "a@trypennie.com", bookable: false, attributes: { role: "Chatter Free User" } }),
      row({ id: "u2", email: "b@trypennie.com", bookable: false, attributes: { role: "Sales" } }),
    ],
    twilio(side(["Low Debt: 20k - 30k"], "a@trypennie.com"), side(["High Debt: 50k+"], "b@trypennie.com")),
  );
  eq(plan.flips.length, 0, "neither a new hire nor somebody already on Sales is flipped by a tier");
}

// --- #2724: the TAG is mirrored for everybody, separately from the mark ------
// The mark records only who Slate itself turned off, so it misses anybody already
// out of the pool when the tag appeared (13 of 22 on 2026-09-10). The Regal call
// detector needs the tag itself, so it is mirrored like the tiers: written for every
// in scope worker whatever their bookable state, removed with the tag, and left
// alone for a row Twilio holds no worker for.

{
  const plan = planTwilioRoster([row({ bookable: false })], twilio(side(["Redistribute"])), NOW);
  eq(plan.flips.length, 0, "an agent already out of the pool is still not flipped");
  eq(plan.attributeWrites.length, 1, "but the tag is written for them");
  const attrs = plan.attributeWrites[0]?.attributes;
  assert(carriesRedistributeTag(attrs), "so a reader asking whether Twilio tags them gets yes");
  assert(!isMarkedRedistribute(attrs), "and they are NOT marked, since Slate did not turn them off");
  eq(plan.attributeWrites[0]?.changes.redistributeTagged.changed, true, "and the write says the tag moved");
}
{
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute_tagged: MARK } })],
    twilio(side(["Redistribute"])),
    NOW,
  );
  eq(plan.attributeWrites.length, 0, "a tag already stored is not rewritten every hour");
}
{
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute_tagged: MARK, debt_team: ["low"] } })],
    twilio(side(["Low Debt: 20k - 30k"])),
    NOW,
  );
  eq(plan.flips.length, 0, "an unmarked agent whose tag came off is still never flipped on");
  eq(plan.attributeWrites.length, 1, "but the tag is removed");
  assert(!carriesRedistributeTag(plan.attributeWrites[0]?.attributes), "so the exemption it grants ends with the tag");
  assert(!("redistribute_tagged" in (plan.attributeWrites[0]?.attributes ?? {})), "the key is deleted, not written as N");
}
{
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute_tagged: MARK } })],
    twilio(side(["Low Debt: 20k - 30k"], "someone.else@trypennie.com")),
    NOW,
  );
  eq(plan.attributeWrites.length, 0, "a row Twilio holds no worker for keeps its stored tag: silence is not removal (L214)");
}
{
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute_tagged: "N" } })],
    twilio(side(["Low Debt: 20k - 30k"])),
    NOW,
  );
  assert(
    !("redistribute_tagged" in (plan.attributeWrites[0]?.attributes ?? {})),
    "a junk spelling of the tag is cleared rather than kept",
  );
}
{
  // Marked, and the tag has come off: the flip's own payload clears both, and what
  // is written if the flip does NOT settle clears the tag while keeping the mark,
  // so a refused reactivation keeps its retry without keeping the exemption.
  const plan = planTwilioRoster(
    [row({ bookable: false, attributes: { redistribute: MARK, redistribute_at: NOW, redistribute_tagged: MARK } })],
    twilio(side(["Low Debt: 20k - 30k"])),
    NOW,
  );
  const flip = plan.flips[0];
  eq(flip?.action, "turn-back-on", "a marked agent whose tag came off is planned back in");
  assert(!carriesRedistributeTag(flip?.attributes) && !isMarkedRedistribute(flip?.attributes), "the settled payload clears the tag and the mark");
  assert(!carriesRedistributeTag(flip?.heldAttributes), "the unsettled payload clears the tag");
  assert(isMarkedRedistribute(flip?.heldAttributes), "and keeps the mark, so the retry survives");
}
{
  const plan = planTwilioRoster([row()], twilio(side(["Redistribute"])), NOW);
  eq(plan.flips[0]?.heldAttributes, null, "a turn off has no unsettled payload: its write lands before the flip");
}
{
  assert(!carriesRedistributeTag(null), "no attributes is not tagged");
  assert(!carriesRedistributeTag({ redistribute: MARK }), "the MARK alone is not the tag: they answer different questions");
}

finish();
