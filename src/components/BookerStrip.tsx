"use client";
import { DateTime } from "luxon";
import { dayChips } from "@/lib/booking/slot-picker";

/**
 * Cold-case loading treatment for the strip (#252): a branded row of placeholder
 * chips while /api/availability is in flight, so the picker area reads as
 * deliberately loading instead of a blank gap that then pops. Decorative
 * (aria-hidden); the times panel carries the working signal (the bobbing dots
 * and "Finding the days you can book.") and the polite announcement. The pulse
 * stops under prefers-reduced-motion. `skeletonClass` carries the theme-aware
 * wash so light and dark both look right.
 *
 * `count` should be the number of days the strip is about to draw, so content
 * landing does not make the row change width (#1336).
 */
export function BookerStripSkeleton({
  skeletonClass,
  count = 4,
}: {
  skeletonClass: string;
  count?: number;
}) {
  return (
    <div aria-hidden="true" className="flex gap-2 overflow-x-auto">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          data-skeleton-chip
          className={`h-[68px] min-w-16 flex-1 animate-pulse rounded-lg motion-reduce:animate-none ${skeletonClass}`}
        />
      ))}
    </div>
  );
}

/**
 * The shared day picker (#1336). Draws the days the booker can actually offer,
 * in order, rather than a fixed seven day window with the unbookable days greyed
 * out: since #1326 the furthest offered day counts BOOKABLE days and can fall
 * outside any fixed window (#1330), and a greyed remainder is a row of chips a
 * lead has to be told to ignore (#1298).
 *
 * Chip contents come from `dayChips`, which is unit tested on its own. A skipped
 * day is drawn as a dashed rule between the two chips either side, so a closed
 * day is visible rather than silently absent. The rule is decorative: assistive
 * tech gets the dates from the chips themselves, and it adds no height.
 */
export function BookerStrip({
  today,
  days,
  activeDay,
  zone,
  onSelect,
}: {
  today: DateTime;
  /** ISO dates the API is offering, ascending. */
  days: string[];
  activeDay: string | null;
  zone: string;
  onSelect: (iso: string) => void;
}) {
  const chips = dayChips(days, today, zone);

  // #261: with nothing bookable, showing a row of greyed disabled chips plus a
  // message read oddly and duplicated the times panel's own empty copy. The
  // strip renders nothing here and the times panel owns the single message.
  if (chips.length === 0) return null;

  return (
    <div role="group" aria-label="Available days" className="flex items-stretch gap-2 overflow-x-auto">
      {chips.map((chip) => {
        const selected = chip.iso === activeDay;
        return (
          <div key={chip.iso} className="flex flex-1 items-stretch gap-2">
            {chip.gapBefore && (
              <div
                data-day-gap
                aria-hidden="true"
                className="my-1 w-0 shrink-0 self-stretch border-l border-dashed border-border"
              />
            )}
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(chip.iso)}
              className={`flex min-h-11 min-w-16 flex-1 flex-col items-center rounded-lg border px-3 py-2 tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky motion-reduce:transition-none ${
                selected
                  ? "border-pennie-sky bg-pennie-sky text-pennie-graphite"
                  : "border-border text-fg hover:border-pennie-sky"
              }`}
            >
              {/* The two small lines are quietened with a real colour, never
                  `opacity`, and carry NO opacity on the selected chip at all:
                  graphite at 70% over the sky fill measures about 3.7:1, an AA
                  fail at this size, and axe catches it on the selected chip only,
                  which is the one state a spot check is least likely to open. */}
              <span
                className={`text-[11px] uppercase tracking-wide ${selected ? "" : "text-fg-muted"}`}
              >
                {chip.label}
              </span>
              <span className="text-lg font-semibold leading-tight">{chip.day}</span>
              <span
                className={`text-[10px] uppercase tracking-wide ${selected ? "" : "text-fg-muted"}`}
              >
                {chip.month}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
