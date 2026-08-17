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
import { nearestSlots, NEAREST_SLOT_COUNT } from "@/lib/booking/nearest-slots";

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

finish();
