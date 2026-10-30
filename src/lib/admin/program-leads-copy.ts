/**
 * The words and the one reading of the placeholder day limit on /admin/program-leads
 * (#4392). Pure, so the page, the action and the node suite share one copy (L41).
 *
 * A program lead is a Salesforce Lead registered for the program; for 30 days their texted
 * booking link may book a time nobody real is free for, on the placeholder advisor, up to
 * the placeholder day limit of such calls on one Eastern day, counted by the day of the
 * CALL (#4255).
 */

/** Where the page lives, so the action redirects to the page the form is on. */
export const PROGRAM_LEADS_HREF = "/admin/program-leads";

/**
 * The limit's bounds and default: `booking_settings_placeholder_day_limit_range` and the
 * column default in migration 0213. The server refuses outside them before the database
 * would, so the refusal names what to enter rather than quoting a constraint.
 */
export const PLACEHOLDER_DAY_LIMIT_MIN = 0;
export const PLACEHOLDER_DAY_LIMIT_MAX = 500;
export const PLACEHOLDER_DAY_LIMIT_DEFAULT = 50;

const LIMIT_REFUSAL = `Enter a whole number from ${PLACEHOLDER_DAY_LIMIT_MIN} to ${PLACEHOLDER_DAY_LIMIT_MAX}.`;

/**
 * The one reading of the limit box. Digits only, so "1e2", "0x10", "12.5" and a sign are
 * refused rather than coerced (`Number` reads all of them), and never NaN, which compares
 * false and would slip past a range check (L50).
 */
export function parsePlaceholderDayLimit(raw: string): { limit: number } | { error: string } {
  const t = raw.trim();
  if (!/^\d{1,3}$/.test(t)) return { error: LIMIT_REFUSAL };
  const n = Number(t);
  if (n < PLACEHOLDER_DAY_LIMIT_MIN || n > PLACEHOLDER_DAY_LIMIT_MAX) return { error: LIMIT_REFUSAL };
  return { limit: n };
}

export const PROGRAM_LEADS_COPY = {
  page: {
    title: "Program leads",
    // L604: the domain, once, under the title. Never what the page's parts are.
    intro:
      "Program leads can book a time nobody real is free for, on the placeholder advisor, for 30 days " +
      "after they are registered. The placeholder day limit caps those calls on one Eastern day.",
  },
  days: {
    heading: "Last 14 days",
    dayColumn: "Eastern day",
    today: "Today",
    // The two groups say which day each column counts by, since a reader comparing a
    // refusal with a booking would otherwise assume they share one.
    byCallDay: "By the day of the call",
    byEventDay: "By the day it happened",
    bookings: "Program bookings",
    onPlaceholder: "On the placeholder",
    noRegalCall: "No Regal call",
    limitRefused: "Refused, day full",
    fallbacks: "Shown real times only",
    /** Said once, on the term, for the reader who does not know it (L604). */
    noRegalCallTerm:
      "Calls on the placeholder whose time has passed with nothing in Regal's call feed for the lead. " +
      "Nobody dials as the placeholder: Regal should send each one to the pool at its time.",
    fallbacksTerm:
      "Program leads shown only the real times because Slate could not read something it needed for " +
      "the extra ones, such as the limit or the day's count.",
    notKnownYet: (n: number) => `${n} not known yet`,
    notKnownYetTerm:
      "Due, but Regal's call feed has received nothing since, so whether anybody called cannot be told yet.",
    empty: "No program lead has booked, been refused or been shown real times only in the last 14 days.",
    unreadable:
      "The last 14 days could not be read, so this page is not showing them. Nothing here means nobody " +
      "booked. Reload in a moment.",
  },
  limit: {
    heading: "Placeholder day limit",
    // A switch's help text says only what its state means (.impeccable.md); a number says
    // what reaching it does, in as few words as carry it.
    rule: "Once a day has this many calls on the placeholder, program leads see only real times for it.",
    label: "Calls on the placeholder per Eastern day",
    save: "Save limit",
    unreadable: "The placeholder day limit could not be read.",
    unreadableMeanwhile:
      "Program leads are being shown real times only until it can be read. Reload in a moment.",
  },
} as const;
