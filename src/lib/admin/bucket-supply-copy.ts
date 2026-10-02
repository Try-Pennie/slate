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
import type { SupplyCell, SupplyFreshness, SupplyTotals } from "./bucket-supply.ts";
import { bucketSpecForXbc } from "../xbc.ts";
import { OFFERED_OPEN_DAYS } from "../availability/bookable-days.ts";

/**
 * The booker's offered window in words, built from a day count so the page
 * cannot keep naming a length the booker no longer offers. One day reads "the
 * next open day"; small counts are spelled out; anything larger is a numeral.
 */
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven"];
export function offeredWindowPhrase(days: number): string {
  if (days === 1) return "the next open day";
  return `the next ${NUMBER_WORDS[days] ?? String(days)} open days`;
}
const WINDOW = offeredWindowPhrase(OFFERED_OPEN_DAYS);

/**
 * Every state this page has a name for.
 *
 * A union rather than a bare string so `tsc` names the omission when a state is
 * added, and so the summary line above the table can only ever count a state the
 * key below it explains (#1938).
 */
export type SupplyLegendId =
  | "nobody-available"
  | "saturated"
  | "some"
  | "none"
  | "no-capacity"
  | "beyond-horizon"
  | "closed"
  | "unknown"
  | "overflows"
  | "other-days";

export interface SupplyLegendEntry {
  /** Its own id: two entries share the `counted` kind, because "every time the
   *  day had" and "none of them" are opposite readings of one measurement. */
  id: SupplyLegendId;
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
    case "overflows":
      // Deliberately quiet: the leads are caught, so nothing here is wrong.
      return { cell: "bg-[var(--bg-alt)] text-fg-muted", mark: "O" };
    case "other-days":
      // Quiet for the same reason: the pool's own other days take its leads.
      return { cell: "bg-[var(--bg-alt)] text-fg-muted", mark: "D" };
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
    id: "overflows",
    label: "Overflows",
    meaning:
      `This pool has no times in ${WINDOW}, so its leads are shown the times of the pool named on the row. Nobody is turned away.`,
    mark: "O",
    cell: "bg-[var(--bg-alt)] text-fg-muted",
    swatchExtra: "border border-border",
  },
  {
    id: "other-days",
    label: "Other days here",
    meaning:
      `This pool has no times that day, and its leads are offered its other days in ${WINDOW}. Nobody is turned away.`,
    mark: "D",
    cell: "bg-[var(--bg-alt)] text-fg-muted",
    swatchExtra: "border border-border",
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

/** One legend entry by id. Throws rather than returning a default, because a
 *  default is indistinguishable from a deliberate choice (L113) and the caller
 *  is the summary line, which would silently start counting under a blank name. */
export function supplyLegendEntry(id: SupplyLegendId): SupplyLegendEntry {
  const found = SUPPLY_LEGEND.find((e) => e.id === id);
  if (!found) throw new Error(`no legend entry for ${id}`);
  return found;
}

/**
 * The summary line and the key are ONE vocabulary (#1938).
 *
 * The page used to name each state three times: the summary said "offering the
 * whole of today", the key said "Bookable", the column headers said something
 * else again, so nothing a reader learned in one place helped them in another.
 * Each chip here names the legend entry it counts and takes its WORDS from that
 * entry, so there is one label per state and both ends of the page read it.
 *
 * Seven of the ten states, and the three missing ones are properties of the
 * DAY rather than of a bucket (closed, nothing left today, past the horizon), so
 * a count of them across buckets would be sixty times one fact.
 */
export const SUPPLY_SUMMARY_STATES: { totalsKey: keyof SupplyTotals; legendId: SupplyLegendId }[] = [
  // Nobody available leads: it is the only one of these that asks for an action.
  { totalsKey: "nobodyAvailable", legendId: "nobody-available" },
  { totalsKey: "saturated", legendId: "saturated" },
  { totalsKey: "partBooked", legendId: "some" },
  { totalsKey: "nothingBooked", legendId: "none" },
  // Its own chip, and NOT an alarming one: an empty pool whose leads are caught
  // turns nobody away (2026-10-02).
  { totalsKey: "overflows", legendId: "overflows" },
  { totalsKey: "otherDays", legendId: "other-days" },
  { totalsKey: "unmeasured", legendId: "unknown" },
];

/** Which summary chips read as something wrong rather than as a state of the
 *  world. `nothingBooked` is every bucket today and is not a fault. */
export const SUPPLY_ALARMING_STATES: SupplyLegendId[] = ["nobody-available", "unknown"];

/**
 * The unit, stated ONCE, over the columns it applies to (#1938).
 *
 * Every number under these headers is a share of appointment START TIMES, and
 * nothing on the page said so except a paragraph above the table, which is where
 * a reader arrives last. A spanning header says it where the numbers are.
 */
export const SUPPLY_DAY_GROUP_HEADER = "Booked share of the appointment times the pool could have taken";

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
    case "overflows":
      return `${when}: this pool has no times in ${WINDOW}, so its leads are shown ${cell.toPool ?? "another pool"}'s times instead.`;
    case "other-days":
      return `${when}: nothing that day, and its leads are offered this pool's other days in ${WINDOW}.`;
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

/**
 * How long ago, in words, with no false precision (#1938).
 *
 * Pure and clock free: both instants are arguments, so the same pair always
 * renders the same string and a test can assert the wording rather than the
 * machine's speed (L290).
 */
export function relativeAge(ageMs: number): string | null {
  // `null` rather than a string, so a caller has to decide what an unreadable
  // age says. Every comparison below is false for NaN, so without this the
  // value falls through to the LAST branch and renders "NaN days ago" (L50):
  // the arm reached is the one that reads as the most confident. A negative age
  // needs no branch of its own, because `Math.floor` already puts it under one
  // minute, and a guard that changes no answer is dead code pretending to be a
  // decision (L29).
  if (!Number.isFinite(ageMs)) return null;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hr ago";
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * What the "Last computed" column SAYS, which is now a time (#1938).
 *
 * The header asks WHEN and the cell used to answer with a grade ("Fresh"), so
 * the one column that could tell a first-time reader whether these numbers are
 * current answered a question nobody had asked. A healthy row states its age and
 * the reader judges it.
 *
 * `stale` and `unknown` keep their WORDS, and that is not an inconsistency: an
 * age past the alarm is a thing to act on rather than a fact to weigh, and a row
 * that has never been computed has no age at all. Both keep the error treatment
 * the grade carried.
 */
export function computedAtLabel(
  freshness: SupplyFreshness,
  computedAtMs: number | null,
  nowMs: number,
): { label: string; meaning: string } {
  const grade = freshnessLabel(freshness);
  if (freshness === "stale" || freshness === "unknown" || computedAtMs === null) return grade;
  const age = relativeAge(nowMs - computedAtMs);
  // An age nobody could compute falls back to the WORD, never to a blank and
  // never to a figure: the column has to keep answering.
  if (age === null) return grade;
  return { label: age, meaning: grade.meaning };
}

/**
 * How one agent count reads. `null` is unknown, which is never zero agents.
 *
 * ONE number, because the column it sits in names one fact (#1938). It used to
 * render `84 (75 today)`, two different measurements in one cell separated by a
 * bracket, which a reader had to decode before they could read it.
 */
export function agentCountLabel(count: number | null): string {
  return count === null ? "Unknown" : String(count);
}

/** The name of the backend digit a group of codes shares. */
export const BACKEND_GROUP_LABEL: Record<string, string> = {
  "0": "No backend param",
  "1": "Both",
  "2": "Beyond",
  "3": "Achieve",
};

/**
 * What a manager's row is called: the pool in words, else the bucket's stored
 * name, and never the code (2026-10-02). A code is how admins configure buckets
 * and means nothing to a sales manager.
 *
 * When the bucket list could not be read the loader names a row by its code, so
 * a name that IS the code is not a name, and the row says its name is unknown
 * rather than showing the code by the back door.
 */
export function poolRowName(row: { code: string; name: string; poolLabel: string | null }): string {
  return row.poolLabel ?? poolRowDetail(row) ?? "Name could not be read";
}

/**
 * What tells one manager row apart from another of the same pool, without a
 * code: the bucket's stored name, or, when that name is only the code (the
 * bucket list was unreadable), the same words spelled out from the code's
 * digits ("Low | Both | Legal"). Null when neither exists, rather than the code.
 *
 * A pool's codes share a row only when they agree, so a split pool draws several
 * rows under one pool name, and this is the line that says which is which.
 */
export function poolRowDetail(row: { code: string; name: string }): string | null {
  const name = row.name.trim();
  if (name && name !== row.code) return name;
  return bucketSpecForXbc(row.code)?.name ?? null;
}

/**
 * Where a row's leads go, said once on the row, or null when it needs saying
 * nowhere. An overflowing row names its one rung (the booker serves one rung for
 * the whole window); a red row whose leads the booker's last resort would offer
 * later days says that, while staying red, because it is the alerting case.
 */
export function leadsNote(row: { cells: SupplyCell[]; offeredLater: boolean }): string | null {
  const overflow = row.cells.find((c) => c.kind === "overflows");
  if (overflow && overflow.kind === "overflows") {
    return `Leads go to ${overflow.toPool ?? "another pool"}`;
  }
  return row.offeredLater ? "Leads are offered later days" : null;
}
