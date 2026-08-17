// #1319: the nearest times to offer after a confirm is refused.
//
// A refusal at confirm is not rare by design. The booker reads a cached availability index and
// the only live check happens at confirm, so the gap between what was shown and what is true is
// closed at exactly that step. The lead has already filled in every field and pressed the final
// button, and answering with a refusal and nothing else is where an otherwise willing customer
// gives up.
//
// The honest error stays (L10: an error state and an empty state are different screens). This
// is what goes BENEATH it: the soonest times that are actually free, from the availability the
// picker just reloaded, so recovery is picking a time rather than starting over.
//
// Run: node --experimental-strip-types scripts/test-nearest-slots.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  nearestSlots,
  NEAREST_SLOT_COUNT,
  rescheduleOffersAlternatives,
} from "@/lib/booking/nearest-slots";
import { REFUSAL_CATALOG } from "@/lib/booking/refusal-catalog";

const iso = (h: number, d = 18) => `2026-08-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;

{
  eq(
    nearestSlots([iso(14), iso(9), iso(11)], 2),
    [iso(9), iso(11)],
    "the soonest come first, whatever order the source arrived in",
  );
}

{
  // Do not assume the API sorts. It does today, and a caller passing a merged or
  // day-grouped list would not, and the failure would be an offer of the LATEST times at
  // the exact moment the lead wants the soonest.
  eq(
    nearestSlots([iso(9, 20), iso(9, 18), iso(9, 19)], 3),
    [iso(9, 18), iso(9, 19), iso(9, 20)],
    "and across days too",
  );
}

{
  eq(nearestSlots([iso(9), iso(10), iso(11), iso(12)], 3).length, 3, "capped at the count asked for");
  eq(nearestSlots([iso(9)], 3), [iso(9)], "fewer available than asked for returns what there is");
  eq(nearestSlots([], 3), [], "nothing available returns nothing, not a placeholder");
}

{
  // The slot they just LOST must not be offered back to them. It is the one time we know is
  // gone, and re-offering it is the dead end this issue is about, wearing a helpful face.
  eq(
    nearestSlots([iso(9), iso(10), iso(11)], 2, iso(9)),
    [iso(10), iso(11)],
    "the refused time is excluded from the alternatives",
  );
  eq(
    nearestSlots([iso(9)], 2, iso(9)),
    [],
    "and when it was the only one, the answer is honestly empty",
  );
}

{
  // Duplicates would render as two identical chips, which reads as a bug to the person
  // looking at it.
  eq(nearestSlots([iso(9), iso(9), iso(10)], 3), [iso(9), iso(10)], "duplicate times collapse");
}

{
  // An unparseable value must not sort as the soonest and become the first thing offered.
  const out = nearestSlots(["not-a-time", iso(10), iso(9)], 3);
  eq(out, [iso(9), iso(10)], "an unreadable time is dropped rather than offered");
}

{
  eq(nearestSlots([iso(9), iso(10)], 0), [], "asking for none returns none");
  assert(
    NEAREST_SLOT_COUNT >= 2 && NEAREST_SLOT_COUNT <= 5,
    "the shipped count is a handful: enough to be a real choice, few enough to scan under an error",
  );
}

// --- which refusals may offer alternatives at all (#1549) ---------------------
// The reschedule endpoint answers 409 for two different things, and the two need
// opposite responses (L11). A time that went is exactly what alternatives are for.
// A booking that MOVED under the reader is not: the page is showing a time that is
// no longer the booking's, so offering to move it from that stale view sends them
// round the same refusal, wearing a helpful face. The status alone cannot tell them
// apart, which is why the route names its reason and this is the only judge of it.
{
  eq(
    rescheduleOffersAlternatives(409, "reschedule_slot_taken"),
    true,
    "the time was taken while they decided: alternatives are the whole point",
  );
  eq(
    rescheduleOffersAlternatives(409, "reschedule_no_eligible_agents"),
    true,
    "nobody is free at that time either: the same dead end, so the same recovery",
  );
  eq(
    rescheduleOffersAlternatives(409, "reschedule_conflict"),
    false,
    "the booking moved under them: the honest answer is refresh, not a list of times",
  );
  eq(
    rescheduleOffersAlternatives(503, "reschedule_verify_unavailable"),
    false,
    "we could not check, so we do not know any time is gone and must not imply one is",
  );
  eq(
    rescheduleOffersAlternatives(500, "reschedule_internal"),
    false,
    "a crash is not a full slot",
  );
  // Fail closed on an unnamed reason. The route and this client ship in one Worker,
  // so an absent reason means a shape we do not recognise rather than an old deploy;
  // withholding the panel leaves the honest error, which is the status quo, while
  // guessing could show the misleading one above.
  eq(rescheduleOffersAlternatives(409, undefined), false, "an unnamed 409 offers nothing");
  eq(rescheduleOffersAlternatives(409, null), false, "and neither does a null reason");
  eq(
    rescheduleOffersAlternatives(409, "something_invented"),
    false,
    "an unrecognised reason offers nothing",
  );
  // Every reason this judge says yes to must be a real refusal id, or a rename would
  // silently turn the panel off and look like a product that simply never offers it
  // (the same reason `test-refusal-catalog.ts` reads its annotations both ways).
  for (const reason of ["reschedule_slot_taken", "reschedule_no_eligible_agents"]) {
    assert(
      REFUSAL_CATALOG.some((r) => r.id === reason),
      `${reason} is a real refusal id, so the route can actually send it`,
    );
  }
}

finish();
