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
 * The three readings a COUNTED cell can take. One kind covers all three, and
 * they are very different facts: every time the day could hold, some of them,
 * and none.
 */
export type SupplyTone = "full" | "partial" | "empty";

export const TONE_CLS: Record<SupplyTone, string> = {
  full: "bg-pennie-sky text-pennie-graphite",
  partial: "bg-pennie-yellow text-pennie-graphite",
  empty: "bg-error/25 text-fg",
};

/** Which tone a measured cell reads in. Decided by the numbers, never by a
 *  threshold guessed here: a pool offering every time the day could hold is a
 *  different fact from one offering most of them. */
export function toneFor(open: number, max: number): SupplyTone {
  if (open <= 0) return "empty";
  return open >= max ? "full" : "partial";
}

/** The classes and fallback mark for one cell. */
export function cellStyle(cell: SupplyCell): { cell: string; mark: string } {
  switch (cell.kind) {
    case "counted":
      return { cell: TONE_CLS[toneFor(cell.open, cell.max)], mark: "" };
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
    id: "full",
    label: "Every time the day had",
    meaning: "This pool is offering the whole of what the office day could hold.",
    mark: "21",
    cell: TONE_CLS.full,
  },
  {
    id: "partial",
    label: "Some of the day",
    meaning: "Part of the day is taken. The number is open starts over what the day could have held.",
    mark: "9",
    cell: TONE_CLS.partial,
  },
  {
    id: "empty",
    label: "Nothing open",
    meaning: "The day had room and this pool is offering none of it.",
    mark: "0",
    cell: TONE_CLS.empty,
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
      if (cell.open === 0) {
        return `${when}: nothing open. The day could have held ${cell.max}.`;
      }
      return `${when}: ${cell.open} of ${cell.max} open, ${sharePercent(cell.share)} percent of what the day could hold.`;
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
