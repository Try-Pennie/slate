// Run: node --experimental-strip-types scripts/test-twilio-redistribute-plan.ts
//
// The decision behind #2097: who the roster sync flips out of the bookable pool
// because Twilio says Redistribute, and who it flips back in.
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
import { planRedistribute, isMarkedRedistribute, type TwilioRosterRow } from "@/lib/twilio/roster-plan";
import { readWorker, workerSideOrNull, type TwilioSide } from "@/lib/twilio/roster";
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
  const plan = planRedistribute([row()], twilio(side(["Redistribute", "Low Debt: 20k - 30k"])));
  eq(plan.flips.length, 1, "a bookable agent carrying the tag is flipped");
  eq(plan.flips[0]?.action, "turn-off", "and the direction is out of the pool");
  eq(plan.flips[0]?.userId, "u1", "named by user id, which is what the flip service takes");
}

{
  const plan = planRedistribute([row({ bookable: true, attributes: { redistribute: MARK } })], twilio(side(["Redistribute"])));
  eq(plan.flips[0]?.action, "turn-off", "a marked agent somebody turned back on by hand is turned off again: Twilio owns the answer");
}

{
  // The case a naive mirror gets wrong in the safe direction and this one gets right.
  const plan = planRedistribute([row({ bookable: false })], twilio(side(["Redistribute"])));
  eq(plan.flips.length, 0, "an agent who is already out of the pool is left alone, not re-flipped");
}

// --- turning somebody back on -------------------------------------------------

{
  const plan = planRedistribute(
    [row({ bookable: false, attributes: { redistribute: MARK, debt_team: ["low"] } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.flips.length, 1, "a marked agent whose tag Twilio has dropped is flipped back");
  eq(plan.flips[0]?.action, "turn-back-on", "and the direction is into the pool");
}

{
  const plan = planRedistribute(
    [row({ bookable: false, attributes: { redistribute: MARK } })],
    twilio(side(["Redistribute"])),
  );
  eq(plan.flips.length, 0, "a marked agent Twilio still withholds stays out, with nothing written");
}

{
  const plan = planRedistribute(
    [row({ bookable: true, attributes: { redistribute: MARK } })],
    twilio(side(["Low Debt: 20k - 30k"])),
  );
  eq(plan.flips[0]?.action, "turn-back-on", "a marked agent already bookable is still planned, so the stale mark gets cleared");
}

// --- the absences, which are not the same as an answer ------------------------

{
  // L214: a source PRESENT but silent about this person is not the same as a tag
  // removed. Flipping them on would be acting on an absence.
  const plan = planRedistribute(
    [row({ bookable: false, attributes: { redistribute: MARK } })],
    twilio(side(["Low Debt: 20k - 30k"], "somebody-else@trypennie.com")),
  );
  eq(plan.flips.length, 0, "a marked agent Twilio holds no worker for is NOT flipped back on");
  eq(plan.markedWithNoWorker, ["someone@trypennie.com"], "and is reported, because doing nothing is otherwise invisible");
}

{
  const plan = planRedistribute([row({ bookable: true })], new Map());
  eq(plan.flips.length, 0, "an empty Twilio side flips nobody off");
}

{
  // The direction that matters: an empty read must not read as "nobody is tagged
  // any more" and re-admit everybody Slate withheld (L98, L214).
  const plan = planRedistribute(
    [row({ bookable: false, attributes: { redistribute: MARK } }), row({ id: "u2", email: "b@trypennie.com", bookable: false, attributes: { redistribute: MARK } })],
    new Map(),
  );
  eq(plan.flips.length, 0, "an empty Twilio side flips nobody back ON either");
  eq(plan.markedWithNoWorker.length, 2, "every marked row is reported instead");
}

// --- who is out of scope entirely --------------------------------------------

{
  const plan = planRedistribute(
    [row({ deactivated: true }), row({ id: "u2", email: "b@trypennie.com", deactivated: true, bookable: false, attributes: { redistribute: MARK } })],
    twilio(side(["Redistribute"]), side(["Low Debt: 20k - 30k"], "b@trypennie.com")),
  );
  eq(plan.flips.length, 0, "somebody who has left the pool is flipped neither way");
  eq(plan.markedWithNoWorker.length, 0, "and is not reported as waiting, because they are gone");
}

{
  const plan = planRedistribute([row({ isTest: true })], twilio(side(["Redistribute"])));
  eq(plan.flips.length, 0, "the SMOKE test agents are never flipped by a real Twilio tag");
}

{
  const plan = planRedistribute([row({ email: "SomeOne@TryPennie.com" })], twilio(side(["Redistribute"])));
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
  const plan = planRedistribute([row()], twilio(side(["Redistribute"])));
  eq(plan.flips[0]?.attributes, { redistribute: MARK }, "turning somebody off writes the mark");
  const back = planRedistribute(
    [row({ bookable: false, attributes: { redistribute: MARK, debt_team: ["low"] } })],
    twilio(side([])),
  );
  eq(back.flips[0]?.attributes, { debt_team: ["low"] }, "turning them back on removes it, leaving every other attribute alone");
}

finish();
