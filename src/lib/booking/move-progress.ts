import type { BulkReassignSummary } from "@/lib/booking/bulk-reassign";

/**
 * What the Move upcoming bookings panel DRAWS and SAYS about a sweep (#2122).
 *
 * THE DEFECT. A move that had nothing to move drew a finished progress bar over
 * zero work: `pct = total === 0 ? 100 : ...`, so the panel showed a full sky bar,
 * a green Done pill, the heading "Move complete", and a single figure reading
 * "Moved 0". A completed bar and a count of nothing contradict each other, and
 * the bar was the loudest thing on the panel, so the contradiction was the first
 * thing read. There was no way to tell it from a move that really did finish.
 *
 * PURE, and separate from the component, for the reason the defect was arithmetic
 * and a sentence: a test that checked the panel rendered would have passed
 * straight through both, and the empty case is exactly the one no fixture reaches.
 *
 * The design was settled with Dan over five rounds on 2026-09-09, and each
 * decision is recorded where it is implemented rather than in a document beside
 * the code.
 */

/** One booking's outcome, as the mark draws it. */
export type MoveMark =
  /** Moved to another advisor. */
  | "moved"
  /** Still on the out agent and needs a person: unplaceable, or failed its retries. */
  | "attention"
  /** The booking was gone, cancelled or completed, so there was no move to make. */
  | "skipped"
  /** Being worked on right now. The only thing that moves on the screen. */
  | "next"
  /** Not reached yet. */
  | "waiting";

/**
 * Above this count a segment stops being a unit anybody can see, so the row draws
 * one continuous fill instead.
 *
 * Measured rather than chosen: at 120 bookings across the real card each segment
 * is about 6.5px with a 1px gap, and the row reads as a hatched texture rather
 * than as a proportion, which is a mark that has stopped carrying its meaning.
 * The fill says the same thing at any count.
 */
export const MAX_SEGMENTS = 60;

export type MoveMarkShape =
  | { kind: "segments"; marks: MoveMark[] }
  | { kind: "fill"; settled: number; total: number };

/**
 * The mark, or `null` when there is nothing to draw.
 *
 * `null` is the whole p0. A move with no items has no proportion to show, and any
 * bar drawn over it is a claim about work that did not happen. The panel says it
 * in words instead, so the outcome and the reason arrive together (L10: an empty
 * state and a finished one are different screens).
 *
 * THREE outcomes, not two, and the third is why the mark used to disagree with
 * its own counts. Dan, counting the boxes on the design round: "there are 4 red
 * boxes but only 3 couldn't place". A skip is not a failure. The engine's own
 * rule is "Booking gone / cancelled / completed then skipped (never a failure)",
 * and only `unplaceable` and `failed` are `ACTIONABLE_ITEM_STATUSES`, meaning the
 * ones a person still has to place by hand. Drawing a skip in the failure's
 * colour made the mark claim something nobody measured.
 *
 * The settled items are laid out moved first, then skips, then the ones needing
 * attention, so the exceptions sit together at the end where they can be counted
 * against the sentence rather than hunted for.
 */
export function moveSegments(summary: BulkReassignSummary): MoveMarkShape | null {
  const { total, counts, done } = summary;
  if (total === 0) return null;

  const attention = counts.unplaceable + counts.failed;
  const skipped = counts.skipped;
  const settled = total - counts.pending;

  if (total > MAX_SEGMENTS) return { kind: "fill", settled, total };

  const marks: MoveMark[] = [];
  for (let i = 0; i < total; i += 1) {
    if (i >= settled) {
      // The one being worked on breathes. That is the only motion on the screen,
      // and it is the single thing a still row cannot say: without it a stalled
      // poll and a slow one are the same picture.
      marks.push(i === settled && !done ? "next" : "waiting");
    } else if (i >= settled - attention) marks.push("attention");
    else if (i >= settled - attention - skipped) marks.push("skipped");
    else marks.push("moved");
  }
  return { kind: "segments", marks };
}

/**
 * What the panel says under the mark, or `null` when there was nothing to move.
 *
 * While it RUNS this is a reading and carries no full stop: a stop on it makes an
 * unfinished thing look finished (Dan, 2026-09-09, on the design round). "One at
 * a time" and "N to go" are both gone, the first because it is obvious from
 * watching it and the second because it is the same fact the count already
 * carries.
 *
 * Finished, each exception is COUNTED here and EXPLAINED on its own row below, so
 * the reason is stated once on the screen rather than twice (L605). Dan: "we
 * don't need the detail in the sentence if it says it below".
 */
export function moveOutcomeSentence(summary: BulkReassignSummary): string | null {
  const { total, counts, done } = summary;
  if (total === 0) return null;

  const moved = counts.moved;
  const head = `Moved ${moved} of ${total}`;
  if (!done) return head;

  const parts: string[] = [];
  // Unplaceable and failed are counted together because they are the same thing
  // to the reader: a booking still sitting on the departed agent that somebody
  // has to place. The difference between them is a retry budget, which is not
  // the reader's business.
  const attention = counts.unplaceable + counts.failed;
  if (attention > 0) parts.push(`${attention} could not be placed`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  return [head, ...parts].join(". ") + ".";
}

export interface MoveProgressLabel {
  min: number;
  max: number;
  now: number;
  /** What a screen reader is told, in place of a bare number. */
  text: string;
}

/**
 * What the mark announces, or `null` when there is no progress to announce.
 *
 * The shipped mark was `role="progressbar"` with `aria-valuenow` and NO
 * accessible name, no `aria-valuemin` and no `aria-valuemax`, so a screen reader
 * read out a value with nothing saying what it measured or what the range was.
 *
 * The value is BOOKINGS, not a percentage, because bookings are what the panel
 * counts everywhere else and a reader hearing "20" should be hearing the same
 * number they can see. The text carries the outcome once it is finished, so a
 * reader who cannot see the three colours is still told which group was which.
 */
export function moveProgressLabel(summary: BulkReassignSummary): MoveProgressLabel | null {
  const { total, counts, done } = summary;
  if (total === 0) return null;
  const settled = total - counts.pending;
  const said = moveOutcomeSentence(summary);
  return {
    min: 0,
    max: total,
    now: settled,
    text: done
      ? `Move complete. ${said}`
      : `Moving ${total} booking${total === 1 ? "" : "s"}. ${said}.`,
  };
}

/**
 * How many consecutive polls may return the same settled count before the panel
 * says so (#2122).
 *
 * The signal is the WORK advancing, not the poll succeeding. A poll that comes
 * back fine having moved nothing is a live emitter over dead work, which is the
 * one thing a liveness signal must never be mistaken for (L106): the old
 * "Last update 4s ago" line was exactly that, since it was stamped whenever the
 * request returned rather than whenever a booking moved.
 *
 * Ten polls at three seconds is thirty seconds of no booking settling.
 * Deliberately generous: the drain works one booking at a time and each does a
 * live Google call, so a slow item is ordinary and a panel that cries stalled at
 * the first pause is one nobody reads twice.
 */
export const STALLED_AFTER_UNCHANGED_POLLS = 10;

/**
 * Whether the move has stopped advancing.
 *
 * Never true once it is done: a finished move is not stalled, it is finished, and
 * saying otherwise is the same class of contradiction as a full bar over zero
 * work.
 */
export function isMoveStalled(unchangedPolls: number, done: boolean): boolean {
  return !done && unchangedPolls >= STALLED_AFTER_UNCHANGED_POLLS;
}
