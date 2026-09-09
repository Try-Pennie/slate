// What the move panel's mark and its sentence say (#2122).
//
// The defect this replaces: a move that had nothing to move drew a FINISHED
// progress bar over zero work. `pct = total === 0 ? 100 : ...`, so the panel
// showed a full bar, a Done pill and a heading reading "Move complete" beside a
// single figure reading "Moved 0". A completed bar and a count of nothing
// contradict each other, and the bar was the loudest thing on the panel.
//
// Both halves are PURE so the claims can be asserted rather than discovered by
// looking: the defect was arithmetic and a sentence, and a test that checked the
// panel rendered would have passed straight through both.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-move-progress.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  MAX_SEGMENTS,
  moveOutcomeSentence,
  moveSegments,
  moveProgressLabel,
  isMoveStalled,
  STALLED_AFTER_UNCHANGED_POLLS,
} from "@/lib/booking/move-progress";

const counts = (over: Partial<Record<string, number>> = {}) => ({
  pending: 0, moved: 0, unplaceable: 0, skipped: 0, failed: 0, cancelled: 0,
  ...over,
}) as Record<string, number>;

// --- the sentence ---------------------------------------------------------

// While it runs it is a READING, not a sentence, so it carries no full stop: a
// stop on it makes an unfinished thing look finished (Dan, 2026-09-09).
eq(
  moveOutcomeSentence({ total: 40, counts: counts({ moved: 20, pending: 20 }), done: false }),
  "Moved 20 of 40",
  "while it runs: the count, with no full stop",
);
eq(
  moveOutcomeSentence({ total: 40, counts: counts({ moved: 0, pending: 40 }), done: false }),
  "Moved 0 of 40",
  "and at the start it says zero rather than nothing",
);

// Finished, it is a sentence. The exceptions are COUNTED here and explained on
// their own rows below, so the reason is not stated twice on one screen (L605).
eq(
  moveOutcomeSentence({ total: 40, counts: counts({ moved: 36, unplaceable: 3, skipped: 1 }), done: true }),
  "Moved 36 of 40. 3 could not be placed. 1 skipped.",
  "finished: the count, then each exception, once each",
);
eq(
  moveOutcomeSentence({ total: 12, counts: counts({ moved: 12 }), done: true }),
  "Moved 12 of 12.",
  "a clean run names no exception it did not have",
);
eq(
  moveOutcomeSentence({ total: 3, counts: counts({ moved: 1, unplaceable: 1, failed: 1 }), done: true }),
  "Moved 1 of 3. 2 could not be placed.",
  "a failure is one a person still has to place, so it is counted with the unplaceable",
);

// The empty case, which is the whole p0. It must NOT say "Moved 0 of 0" and must
// not be reachable through the same wording as a finished run: an empty state and
// a completed one are different screens.
eq(
  moveOutcomeSentence({ total: 0, counts: counts(), done: true }),
  null,
  "nothing to move is not a count at all, so the panel says it in its own words",
);

// --- the mark -------------------------------------------------------------

{
  // Nothing to draw over zero work. This is the defect: a full bar and a Done
  // pill over a move that moved nothing.
  eq(moveSegments({ total: 0, counts: counts(), done: true }), null, "no mark at all when there was nothing to move");
}

{
  // Three outcomes, not two. Dan, counting: "there are 4 red boxes but only 3
  // couldn't place". A skip is not a failure: the engine's own rule is "Booking
  // gone / cancelled / completed then skipped (never a failure)".
  const seg = moveSegments({ total: 40, counts: counts({ moved: 36, unplaceable: 3, skipped: 1 }), done: true })!;
  eq(seg.kind, "segments", "at 40 it is one segment per booking");
  eq(seg.marks.length, 40, "one mark per booking, not per percent");
  eq(seg.marks.filter((m) => m === "moved").length, 36, "36 moved");
  eq(seg.marks.filter((m) => m === "attention").length, 3, "3 need a person, matching the count exactly");
  eq(seg.marks.filter((m) => m === "skipped").length, 1, "and the skip is its own mark, not a failure");
  eq(seg.marks.filter((m) => m === "waiting").length, 0, "nothing is left waiting once it is done");
  eq(seg.marks.filter((m) => m === "next").length, 0, "and nothing is breathing once it is done");
}

{
  // Mid run: the settled ones, then the one being worked on, then the rest.
  const seg = moveSegments({ total: 10, counts: counts({ moved: 4, pending: 6 }), done: false })!;
  eq(seg.marks.slice(0, 4).join(","), "moved,moved,moved,moved", "what has landed");
  eq(seg.marks[4], "next", "the one being worked on breathes, which is the still-alive signal");
  eq(seg.marks.filter((m) => m === "waiting").length, 5, "and the rest wait");
}

{
  // A failed item counts with the ones needing attention, because that is what
  // ACTIONABLE_ITEM_STATUSES means: it stays on the out agent for a person.
  const seg = moveSegments({ total: 4, counts: counts({ moved: 2, failed: 1, skipped: 1 }), done: true })!;
  eq(seg.marks.filter((m) => m === "attention").length, 1, "a failure needs a person too");
  eq(seg.marks.filter((m) => m === "skipped").length, 1, "and is told apart from a skip");
}

{
  // Above the ceiling a segment stops being a unit anybody can see, so the row
  // becomes one fill. Measured: at 120 across the real card each segment is about
  // 6.5px and the row reads as a hatched texture rather than a proportion.
  const seg = moveSegments({ total: MAX_SEGMENTS + 1, counts: counts({ moved: 10, pending: MAX_SEGMENTS - 9 }), done: false })!;
  eq(seg.kind, "fill", "above the ceiling it is a continuous fill");
  eq(seg.settled, 10, "carrying how many are settled");
  eq(seg.total, MAX_SEGMENTS + 1, "and out of how many");
  // The boundary itself is still segments, so the ceiling is inclusive and a
  // reader cannot meet a count that draws neither.
  eq(moveSegments({ total: MAX_SEGMENTS, counts: counts({ moved: MAX_SEGMENTS }), done: true })!.kind, "segments",
     "the ceiling itself still draws segments");
}

{
  // A single booking is a real case a fixture never reaches, and it must not
  // divide by anything or draw an empty row.
  const seg = moveSegments({ total: 1, counts: counts({ moved: 1 }), done: true })!;
  eq(seg.marks.length, 1, "one booking draws one mark");
  eq(seg.marks[0], "moved", "and it is the outcome it had");
}

// --- what a screen reader is told -----------------------------------------
//
// The shipped mark was `role="progressbar"` with `aria-valuenow` and NO
// accessible name, no min and no max, so it announced a bare number with nothing
// saying what it measured or what the range was.

{
  const label = moveProgressLabel({ total: 40, counts: counts({ moved: 20, pending: 20 }), done: false });
  assert(label !== null, "a running move has a label");
  eq(label!.now, 20, "valuenow is bookings settled, not a percent");
  eq(label!.max, 40, "valuemax is the bookings there are");
  eq(label!.min, 0, "and valuemin is stated rather than assumed");
  assert(/moving|move/i.test(label!.text), `names what it measures, got ${label!.text}`);
  assert(/40/.test(label!.text), "and says the range in words too, for a reader who hears the text");
}

{
  // The value text says the OUTCOME once finished, so a reader who cannot see the
  // colours is told which of the three each group was.
  const label = moveProgressLabel({ total: 40, counts: counts({ moved: 36, unplaceable: 3, skipped: 1 }), done: true })!;
  eq(label.now, 40, "a finished move is at its maximum");
  assert(/could not be placed/i.test(label.text), "and the text carries the exceptions");
}

{
  eq(moveProgressLabel({ total: 0, counts: counts(), done: true }), null,
     "and nothing to move announces no progress at all, because there was none");
}

// --- stalled is about the WORK, not the poll ------------------------------
//
// The line this replaces read "Last update 4s ago" and was stamped whenever the
// REQUEST came back, so a poll succeeding over a drain that had stopped moving
// anything looked exactly like healthy progress (L106). The signal is the settled
// count advancing.

assert(!isMoveStalled(0, false), "a move that just advanced is not stalled");
assert(!isMoveStalled(STALLED_AFTER_UNCHANGED_POLLS - 1, false), "nor one a poll short of the threshold");
assert(isMoveStalled(STALLED_AFTER_UNCHANGED_POLLS, false), "at the threshold it says so");
assert(isMoveStalled(STALLED_AFTER_UNCHANGED_POLLS + 40, false), "and stays saying so");

// A finished move is not stalled, it is finished. Saying otherwise is the same
// contradiction as a full bar over zero work.
assert(!isMoveStalled(STALLED_AFTER_UNCHANGED_POLLS + 1, true), "a finished move is never stalled");

finish();
