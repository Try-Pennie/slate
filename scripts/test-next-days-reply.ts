// #2155: the booker's "see our next available days" search read a 200 as
// `{ slots?: string[] }` and did `setNextDaySlots(res.data.slots ?? [])`, so a
// reply whose slots were missing, null or not strings rendered on the LEAD facing
// screen as "we looked and there are no times".
//
// That is the worst direction for this particular read. It is the LAST thing
// offered to a lead who has found nothing nearby, so a confident "nothing" ends
// the visit, and nothing logs or alerts because the code path that ran is the
// healthy one.
//
// The guard is calibrated against what the ROUTE actually sends, not against
// fixtures written beside it, because a predicate agreed with by its own author's
// assumption about the server is not a predicate about the server (L48, L52).
// Run: node --experimental-strip-types scripts/test-next-days-reply.ts
import { assert, finish } from "./lib/harness.ts";
import {
  isNextDaysReply,
  NEXT_DAYS_FAILURE,
  nextDaysFailureFor,
} from "../src/lib/booking/next-days-reply.ts";
import { findNextAvailableSlots } from "../src/lib/availability/next-available.ts";

// 1. Calibration: whatever the real producer returns must be accepted. This is the
//    control that stops the guard drifting into refusing the healthy case, which
//    would turn every successful search into an error screen.
{
  const slots = await findNextAvailableSlots({
    probes: [{ fromIso: "2026-10-01T00:00:00.000Z", toIso: "2026-10-08T00:00:00.000Z" }],
    wantDays: 2,
    zone: "America/New_York",
    compute: async () => [
      "2026-10-01T13:00:00.000Z",
      "2026-10-01T13:20:00.000Z",
      "2026-10-02T13:00:00.000Z",
    ],
  });
  assert(slots.length > 0, "the producer control actually produced slots");
  assert(isNextDaysReply({ slots }), "accepts what the route really sends");
}

// 2. An empty search is a legitimate, healthy answer and must stay distinguishable
//    from a broken one. This is the whole point: "we looked and found nothing" is a
//    real result the copy already has a sentence for.
{
  assert(isNextDaysReply({ slots: [] }), "accepts a genuinely empty result");
}

// 3. Every shape a 200 can carry that is NOT that. Each one used to be read as an
//    empty result.
{
  const refused: Array<[string, unknown]> = [
    ["a missing slots key", {}],
    ["a null slots", { slots: null }],
    ["slots as a string", { slots: "2026-10-01T13:00:00.000Z" }],
    ["slots as an object", { slots: { 0: "2026-10-01T13:00:00.000Z" } }],
    ["a list holding a number", { slots: [1759323600000] }],
    ["a list holding null", { slots: ["2026-10-01T13:00:00.000Z", null] }],
    ["a list holding an object", { slots: [{ start: "2026-10-01T13:00:00.000Z" }] }],
    ["an error page answered 200", { error: "Bad gateway" }],
    ["a bare array", ["2026-10-01T13:00:00.000Z"]],
    ["null", null],
    ["a string", "ok"],
    ["undefined", undefined],
  ];
  for (const [name, value] of refused) {
    assert(!isNextDaysReply(value), `refuses ${name}`);
  }
}

// 4. The two failures are told apart, because they send the lead to do different
//    things and one message answering for the other is how somebody spends an
//    evening on a connection that was never the problem (L11).
{
  assert(
    nextDaysFailureFor({ ok: false }) === NEXT_DAYS_FAILURE.unreachable,
    "a request that never landed is unreachable",
  );
  assert(
    nextDaysFailureFor({ ok: true, data: { slots: null } }) === NEXT_DAYS_FAILURE.unreadable,
    "a 200 this cannot read is unreadable",
  );
  assert(
    nextDaysFailureFor({ ok: true, data: { slots: [] } }) === null,
    "a readable reply is not a failure at all, however empty",
  );
  assert(
    NEXT_DAYS_FAILURE.unreachable !== NEXT_DAYS_FAILURE.unreadable,
    "the two are distinct values, not two names for one",
  );
}

finish();
