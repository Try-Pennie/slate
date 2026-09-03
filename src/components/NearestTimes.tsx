"use client";

import { DateTime } from "luxon";
import { formatClockTime } from "@/lib/date/parse";

import { NEAREST_TIMES_COPY } from "@/lib/booking/booker-copy";
import { nearestSlots, NEAREST_SLOT_COUNT } from "@/lib/booking/nearest-slots";
import type { SlotPickerView } from "@/lib/booking/slot-picker";

/**
 * The soonest times still open, under a refusal (#1319, #1549).
 *
 * One panel, three lead-facing surfaces: the booker's confirm, the booker's offer to move a
 * call the lead already has, and the manage page's reschedule. Every one of them reads the
 * same cached availability index and does its only live check at the final step, so every one
 * of them can refuse a time the lead was just looking at. #1319 fixed the first and left the
 * other two as dead ends, which is the fix-the-instance-not-the-class pattern (L30), and a
 * private copy per surface is exactly the divergence #1336 removed from the picker itself.
 *
 * Every state is rendered, because the degenerate ones are where a recovery turns back into
 * the dead end this replaces, and each needs its own words (L22). "We are still looking",
 * "there is nothing", and "we could not look" are three different screens (L10, L11), and the
 * first exists because a time-taking step must never present as a blank.
 *
 * The tap SELECTS. Booking or moving on the tap would turn a glance into a commitment, right
 * after the product has already surprised them once. What "selects" means is the caller's,
 * because the commit step differs (a Confirm button on the booker, the day's own time list on
 * manage) and this panel says nothing about it.
 */
export function NearestTimesPanel({
  refused,
  slots,
  view,
  zone,
  variant,
  onSelect,
}: {
  /** The time that was just refused, or null to render nothing. It is excluded from the
   *  offer: it is the one time we KNOW is gone, and the reload can still be carrying it. */
  refused: string | null;
  /** Every time currently on offer, flat, from the shared picker. */
  slots: string[];
  /** The picker's view, so a reload in flight and a failed reload are told apart. */
  view: SlotPickerView;
  /** The viewer's zone, so a chip is labelled with the day they would see it on. */
  zone: string;
  /** `book` is a lead part-way through booking; `move` is a lead who already has a call. */
  variant: "book" | "move";
  /** Called with the chosen time. Selecting, never committing. */
  onSelect: (iso: string) => void;
}) {
  if (!refused) return null;

  const nearest = nearestSlots(slots, NEAREST_SLOT_COUNT, refused);
  const muted = "text-fg-muted";

  return (
    <div className="mt-3 text-sm" data-testid="nearest-times">
      {view.kind === "loading" ? (
        <p className={muted}>{NEAREST_TIMES_COPY.looking}</p>
      ) : view.kind === "failed" ? (
        // The sentence, but deliberately NOT a second Try again: the picker's own load-error
        // notice is already on screen with one, and two identical controls a few lines apart
        // read as a broken page. What this adds is the explanation for THIS moment, which is
        // not the same as "there is nothing free" and must not share its words (L11); the
        // route out is the control that is already there (L80).
        <p className={muted}>{NEAREST_TIMES_COPY.lookupFailed}</p>
      ) : nearest.length === 0 ? (
        <p className={muted}>{NEAREST_TIMES_COPY.none}</p>
      ) : (
        <>
          <p className="mb-2 font-medium">{NEAREST_TIMES_COPY.heading}</p>
          <div className="flex flex-wrap gap-2">
            {nearest.map((iso) => (
              <button
                key={iso}
                type="button"
                data-testid="nearest-time"
                data-slot={iso}
                className="inline-flex min-h-11 items-center rounded-md border border-border bg-surface px-3 text-sm tabular-nums text-fg transition-colors hover:border-fg/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky"
                onClick={() => onSelect(iso)}
              >
                {/* One spelling for the time (#1765); the date keeps its own. */}
                {`${DateTime.fromISO(iso, { zone }).toFormat("ccc d LLL")}, ${
                  formatClockTime(DateTime.fromISO(iso, { zone })) ?? ""
                }`}
              </button>
            ))}
          </div>
          <p className={`mt-2 ${muted}`}>
            {variant === "move" ? NEAREST_TIMES_COPY.hintMove : NEAREST_TIMES_COPY.hint}
          </p>
        </>
      )}
    </div>
  );
}
