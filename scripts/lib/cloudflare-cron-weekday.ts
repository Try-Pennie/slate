// The weekday field of a Cloudflare Workers cron expression (#2814).
//
// Cloudflare numbers weekdays 1 = Sunday to 7 = Saturday, which is NOT the 0 =
// Sunday to 6 = Saturday most cron systems use
// (https://developers.cloudflare.com/workers/configuration/cron-triggers/). So a
// numeric weekday reads correctly to nobody: `1-5` looks like Monday to Friday and
// is Sunday to Thursday on Cloudflare. That is exactly how the pending time off
// nudge stopped running on Fridays. The three letter names (`MON-FRI`) mean the
// same thing on every cron system, so they are the only form allowed here.
//
// Pure, so the guard and the time off bounds suite share ONE reading of the field.

/** Index = JavaScript's getUTCDay() (0 = Sunday), so a parse feeds a Date directly. */
export const WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

/** The fifth field of a cron expression, or null when it does not have five. */
export function weekdayField(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  return parts.length === 5 ? parts[4]! : null;
}

/**
 * Why this expression's weekday field is refused, or null when it is fine.
 * A field carrying ANY digit is refused, because its meaning depends on which
 * cron system reads it; `*` and names are accepted.
 */
export function numericWeekdayProblem(cron: string): string | null {
  const dow = weekdayField(cron);
  if (dow === null) return `"${cron}" does not have five fields`;
  if (/\d/.test(dow)) {
    return `"${cron}" writes its weekday as a number ("${dow}"); Cloudflare counts 1 = Sunday, so write the day names instead (MON-FRI, not 1-5)`;
  }
  return null;
}

/**
 * The days a weekday field fires on, as getUTCDay() values (0 = Sunday), or null
 * for any shape this does not understand. Accepts `*`, a name, a `NAME-NAME`
 * range and comma lists of those, case insensitively, which is what Cloudflare
 * accepts. REFUSES numbers rather than guessing a convention for them, since a
 * guessed convention is the bug this exists to prevent.
 */
export function parseWeekdayField(dow: string): Set<number> | null {
  if (dow === "*") return new Set([0, 1, 2, 3, 4, 5, 6]);
  const index = (name: string) => WEEKDAY_NAMES.indexOf(name.toUpperCase() as (typeof WEEKDAY_NAMES)[number]);
  const out = new Set<number>();
  for (const part of dow.split(",")) {
    const range = /^([A-Za-z]{3})(?:-([A-Za-z]{3}))?$/.exec(part);
    if (!range) return null;
    const lo = index(range[1]!);
    const hi = range[2] === undefined ? lo : index(range[2]);
    if (lo < 0 || hi < 0 || hi < lo) return null;
    for (let d = lo; d <= hi; d++) out.add(d);
  }
  return out;
}
