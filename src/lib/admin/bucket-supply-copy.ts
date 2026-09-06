/**
 * What each cell of the bucket supply table SAYS (#1254).
 *
 * Lifted out of the page for the same reason the alert, booker and grid copy is
 * (#1153, #1343, #1302): a string somebody reads is a contract, and one living
 * inline in markup can only be read by a browser. Here it is also what a screen
 * reader gets, because a cell's visible content is a bare number or a single
 * letter.
 *
 * The letters and the numbers exist because color is never the sole signal.
 * Seven treatments in one table would otherwise be seven tints somebody has to
 * hold in their head, and several of them would arrive as the same grey.
 *
 * PURE, so the node suite and the component test drive the real wording rather
 * than a second copy of it (L41).
 */
import type { SupplyCell, SupplyFreshness } from "./bucket-supply.ts";

export interface SupplyLegendEntry {
  /** Its own id: two entries share the `counted` kind, because "every time the
   *  day had" and "none of them" are opposite readings of one measurement. */
  id: string;
  /** The legend's name for it. */
  label: string;
  /** The legend's one line explanation, in a reader's terms. */
  meaning: string;
  /** The letter or number shown in the swatch. */
  mark: string;
  /** The swatch's classes, taken from the same place the cell takes them, so a
   *  tint can never be right in the table and wrong in the key that explains it. */
  cell: string;
  /** Extra classes the swatch needs to be visible when it has no fill. */
  swatchExtra?: string;
}

/**
 * The three readings a COUNTED cell can take, and they INVERTED with the metric
 * (#1937).
 *
 * The cell used to be how much was OFFERED, so offering nothing was the alarm
 * and offering everything was the reassurance. It is now how much was BOOKED, so
 * those two swap: a pool with nothing booked is the ordinary state (it is every
 * bucket today, since cal.com still takes every lead), and a pool whose every
 * possible time is taken is the one with nothing left to give.
 *
 * So `none` is deliberately UNALARMING and `saturated` is the notable one. The
 * state actually worth acting on is not a share at all: it is
 * `nobody-available`, which has no ceiling to be a share of and carries the
 * error treatment below.
 */
export type SupplyTone = "saturated" | "some" | "none";

export const TONE_CLS: Record<SupplyTone, string> = {
  // Every possible time taken: nothing left for a new lead.
  saturated: "bg-pennie-sky text-pennie-graphite",
  some: "bg-pennie-yellow text-pennie-graphite",
  // Quiet, not wrong. An error tint here would paint the entire page red today.
  none: "bg-[var(--bg-alt)] text-fg-muted",
};

/** Which tone a measured cell reads in. Decided by the numbers, never by a
 *  threshold guessed here: every possible time taken is a different fact from
 *  most of them. */
export function toneFor(booked: number, capacity: number): SupplyTone {
  if (booked <= 0) return "none";
  return booked >= capacity ? "saturated" : "some";
}

/** The classes and fallback mark for one cell. */
export function cellStyle(cell: SupplyCell): { cell: string; mark: string } {
  switch (cell.kind) {
    case "counted":
      return { cell: TONE_CLS[toneFor(cell.booked, cell.capacity)], mark: "" };
    case "nobody-available":
      // The one state on this page somebody has to act on, so it keeps the error
      // treatment the old "nothing open" cell had, and a letter of its own.
      return { cell: "bg-error/25 text-fg", mark: "N" };
    case "no-capacity":
      return { cell: "bg-[var(--bg-alt)] text-fg-muted", mark: "T" };
    case "beyond-horizon":
      return { cell: "bg-[var(--bg-alt)] text-fg-muted", mark: "H" };
    case "closed":
      return { cell: "bg-transparent text-fg-muted", mark: "" };
    case "unknown":
      return { cell: "bg-transparent text-fg-muted", mark: "?" };
  }
}

/**
 * Ordered most to least actionable, which is also the order somebody scans a key
 * in.
 */
export const SUPPLY_LEGEND: SupplyLegendEntry[] = [
  {
    id: "nobody-available",
    label: "Nobody available",
    meaning:
      "The day had room for appointments and this pool has none: none offered, and none booked. This is the one to act on.",
    mark: "N",
    cell: "bg-error/25 text-fg",
  },
  {
    id: "saturated",
    label: "Every time taken",
    meaning: "Every time this pool could have taken an appointment at is booked. Nothing is left for a new lead.",
    mark: "100%",
    cell: TONE_CLS.saturated,
  },
  {
    id: "some",
    label: "Part booked",
    meaning:
      "Some of the times this pool could take are booked. The number is booked starts out of the times it could have taken.",
    mark: "45%",
    cell: TONE_CLS.some,
  },
  {
    id: "none",
    label: "Nothing booked",
    meaning:
      "This pool has times to offer and none of them are taken. Every bucket reads this way until leads start arriving in Slate.",
    mark: "0%",
    cell: TONE_CLS.none,
    swatchExtra: "border border-border",
  },
  {
    id: "no-capacity",
    label: "Nothing left today",
    meaning:
      "The office is open but no whole appointment fits between the notice cutoff and closing. Not a booked out pool.",
    mark: "T",
    cell: "bg-[var(--bg-alt)] text-fg-muted",
    swatchExtra: "border border-border",
  },
  {
    id: "beyond-horizon",
    label: "Past this pool's horizon",
    meaning:
      "This pool already found its allowance of bookable days earlier in the window, so nothing was computed this far out.",
    mark: "H",
    cell: "bg-[var(--bg-alt)] text-fg-muted",
    swatchExtra: "border border-border",
  },
  {
    id: "closed",
    label: "Closed",
    meaning: "The office is not open that day.",
    mark: "",
    cell: "bg-transparent text-fg-muted",
    swatchExtra: "border border-border",
  },
  {
    id: "unknown",
    label: "Could not check",
    meaning:
      "This pool's cached answer could not be read, so nothing here was measured. It is not a report that the pool is empty.",
    mark: "?",
    cell: "bg-transparent text-fg-muted",
    swatchExtra: "border border-dashed border-border",
  },
];

/** How a share reads as a percentage, with no false precision. */
export function sharePercent(share: number): number {
  return Math.round(share * 100);
}

/**
 * The sentence a cell says on hover and to a screen reader.
 *
 * It states the counts where they were MEASURED, and states no count at all
 * where nothing was, which is the distinction the whole page exists to make.
 */
export function supplyCellTitle(cell: SupplyCell, bucketLabel: string, dayLabel: string): string {
  const when = `${bucketLabel} on ${dayLabel}`;
  switch (cell.kind) {
    case "counted":
      if (cell.booked === 0) {
        return `${when}: nothing booked, out of ${cell.capacity} times it could have taken.`;
      }
      return `${when}: ${cell.booked} of ${cell.capacity} possible times booked, ${sharePercent(cell.share)} percent.`;
    case "nobody-available":
      return `${when}: nobody available. The day had room for appointments and this pool has none offered and none booked.`;
    case "no-capacity":
      return `${when}: nothing left today. The office is open but no whole appointment fits before closing.`;
    case "beyond-horizon":
      return `${when}: past this pool's horizon. It found its allowance of bookable days earlier in the window.`;
    case "closed":
      return `${when}: the office is closed.`;
    case "unknown":
      return `${when}: could not be checked, because this pool's cached answer could not be read.`;
  }
}

/** What a freshness state is called, and what it should make a reader do. */
export function freshnessLabel(freshness: SupplyFreshness): { label: string; meaning: string } {
  switch (freshness) {
    case "fresh":
      return { label: "Fresh", meaning: "Recomputed within the last few minutes." };
    case "aging":
      return {
        label: "Due a refresh",
        meaning: "Past its freshness window and waiting on the next recompute. Normal.",
      };
    case "stale":
      return {
        label: "Stale",
        meaning:
          "Older than the point the staleness alarm fires, so these numbers may not be what the booker is serving.",
      };
    case "unknown":
      return {
        label: "Never computed",
        meaning: "There is no readable recompute stamp, so nothing here is a current answer.",
      };
  }
}

/** How a depth reads. `null` is unknown, which is never zero agents. */
export function depthLabel(depth: number | null, effectiveDepth: number | null): string {
  if (depth === null) return "Unknown";
  if (effectiveDepth !== null && effectiveDepth !== depth) return `${depth} (${effectiveDepth} today)`;
  return String(depth);
}

/** The name of the backend digit a group of codes shares. */
export const BACKEND_GROUP_LABEL: Record<string, string> = {
  "0": "No backend param",
  "1": "Both",
  "2": "Beyond",
  "3": "Achieve",
};
