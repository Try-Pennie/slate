/**
 * The rules of the two "Days offered" settings (#3922), pure.
 *
 * OFFERED OPEN DAYS is how many open business days every lead is offered (#2840).
 * It was the constant `OFFERED_OPEN_DAYS = 3` until #3922, when Dan asked to change
 * it himself without a deploy; it is `booking_settings.offered_open_days` now, read
 * through `src/lib/booking/days-offered-load.ts`. The constant below is only the
 * column's default, the value a database that predates the column reads as.
 *
 * LAST RESORT EXTRA DAYS is how many more days the last resort (#2841) may open when
 * every tier a lead may use is full for the offered days. It is not stored as such:
 * the reach the rest of the system already reads is `horizon_days`, and it stays
 * offered plus extra, so the availability compute, the slot cache, the supply page
 * and every monitor that reads the horizon keep working unchanged. Entering the
 * extra rather than the furthest day means the reach can never fall short of the
 * offered days (D2 in docs/design/days-offered.html).
 *
 * Both are bounded by `DAYS_OFFERED_CEILING`, 7, the existing ceiling on how far
 * ahead availability is computed: past it the times do not exist (D6).
 *
 * No `@/` imports, so the node suite, the client card and the e2e spec all reach it.
 */
import { EXTRA_DAYS_LABEL, OFFERED_DAYS_LABEL } from "../admin/days-offered-copy.ts";

/** What a lead is offered when nothing has been saved: today's value (#2840). */
export const OFFERED_OPEN_DAYS_DEFAULT = 3;

/** At least one day is always offered. */
export const OFFERED_OPEN_DAYS_MIN = 1;

/** The furthest day the last resort can reach, and the most days offered. */
export const DAYS_OFFERED_CEILING = 7;

const isWhole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/**
 * The stored offered days as a number. A missing row (or a null, which the column's
 * NOT NULL forbids) reads as the default, which is exactly what the column would
 * hold. A value outside the range is impossible behind the column's check, so one
 * arriving here means something else is wrong, and it THROWS rather than being
 * replaced by a guess that changes what every lead is shown.
 */
export function resolveOfferedOpenDays(stored: unknown): number {
  if (stored === null || stored === undefined) return OFFERED_OPEN_DAYS_DEFAULT;
  if (isWhole(stored) && stored >= OFFERED_OPEN_DAYS_MIN && stored <= DAYS_OFFERED_CEILING) return stored;
  throw new Error(`booking_settings.offered_open_days is not a day count from 1 to 7: ${String(stored)}`);
}

/** The values the offered dropdown lists. */
export function offeredDayChoices(): number[] {
  return Array.from({ length: DAYS_OFFERED_CEILING - OFFERED_OPEN_DAYS_MIN + 1 }, (_, i) => OFFERED_OPEN_DAYS_MIN + i);
}

/** The values the extra dropdown lists: 0 up to what keeps the sum at the ceiling. */
export function extraDayChoices(offered: number): number[] {
  const most = Math.max(0, DAYS_OFFERED_CEILING - offered);
  return Array.from({ length: most + 1 }, (_, i) => i);
}

/**
 * A value restored from a save that never arrived (#1994), kept only when it is one
 * of `allowed`. Anything else (a fraction, text, a number outside the list) is
 * null, so the card falls back to the saved value rather than holding a number its
 * dropdown cannot show while the hidden input posts it.
 */
export function restoredChoice(raw: string | null, allowed: number[]): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && allowed.includes(n) ? n : null;
}

/**
 * The extra days a stored reach implies. A reach below the offered days (a legacy
 * horizon of 1 to 2 under the default 3) is 0 rather than a negative count, and
 * never more than the ceiling allows.
 */
export function extraFromStored(offered: number, horizon: number): number {
  return Math.min(Math.max(0, horizon - offered), Math.max(0, DAYS_OFFERED_CEILING - offered));
}

/** The furthest day a lead can be offered, and the sum that makes it (D3). */
export function furthestDay(offered: number, extra: number): { day: number; offered: number; extra: number } {
  return { day: offered + extra, offered, extra };
}

export interface DaysOfferedFormPayload {
  offered_open_days: number | null;
  /** The reach to store: offered plus extra. */
  horizon_days: number | null;
  extra_days: number | null;
  errors: string[];
}

function wholeNumber(raw: string): number | null {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
}

/**
 * Parse and validate the card's two fields. The dropdowns cannot produce an out of
 * range value, so every refusal here is the server holding its own line against a
 * hand built post: offered 1 to 7, extra 0 or more, and the two together at most 7.
 * Nothing is returned to store unless all three hold.
 *
 * BLANK IS REFUSED, carried over from the horizon box this replaces (#1924, Dan: "we
 * shouldn't allow it to be blank ... if they try to save with no number, just error
 * and don't let them"). The READER'S fallback for a null `horizon_days` stays in
 * `resolveHorizonDays`, deliberately: null rows can exist, and this form refusing
 * blank does not make them go away.
 */
export function parseDaysOfferedForm(rawOffered: string, rawExtra: string): DaysOfferedFormPayload {
  const refused = (errors: string[]): DaysOfferedFormPayload => ({
    offered_open_days: null,
    horizon_days: null,
    extra_days: null,
    errors,
  });
  const offered = wholeNumber(rawOffered);
  const extra = wholeNumber(rawExtra);
  const errors: string[] = [];
  if (offered === null || offered < OFFERED_OPEN_DAYS_MIN || offered > DAYS_OFFERED_CEILING) {
    errors.push(`${OFFERED_DAYS_LABEL} must be a whole number from ${OFFERED_OPEN_DAYS_MIN} to ${DAYS_OFFERED_CEILING}.`);
  }
  if (extra === null || extra < 0 || extra > DAYS_OFFERED_CEILING) {
    errors.push(`${EXTRA_DAYS_LABEL} must be a whole number from 0 to ${DAYS_OFFERED_CEILING}.`);
  }
  if (errors.length > 0) return refused(errors);
  if (offered! + extra! > DAYS_OFFERED_CEILING) {
    return refused([
      `${OFFERED_DAYS_LABEL} plus ${EXTRA_DAYS_LABEL.toLowerCase()} can be at most ${DAYS_OFFERED_CEILING}, ` +
        `and ${offered} plus ${extra} is ${offered! + extra!}.`,
    ]);
  }
  return { offered_open_days: offered, horizon_days: offered! + extra!, extra_days: extra, errors: [] };
}
