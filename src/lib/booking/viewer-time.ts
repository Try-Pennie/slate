import { DateTime } from "luxon";
import { formatClockTime } from "../date/parse.ts";
import { formatSlotDay } from "./slot-label.ts";

/**
 * THE formatter for a booking time shown to staff (#1916): `Fri, Jul 3, 11:00am MST`.
 *
 * Whose zone: the VIEWER's (Dan, 2026-09-24). The roster spans seven zones
 * (#1739), so no single zone is right for everybody reading a list, and a time
 * with no zone on it cannot be read correctly by anybody. Rendering in the
 * reader's own zone, with the abbreviation on screen, puts every row on one
 * screen in one zone and says which.
 *
 * `zone` is REQUIRED and never defaulted: the only caller that knows it is the
 * device reading the page, which is why `ViewerTime` (a client component) is the
 * one place this is called from on a staff surface. A server has no viewer, so a
 * default here would be a guess, and a guess is how every surface came to render
 * Eastern. `scripts/test-booking-time-zone-guard.ts` fails the next hard coded
 * zone.
 *
 * Null for an unreadable instant or zone, never a plausible time (L67).
 */
export function formatViewerTime(
  iso: string,
  zone: string,
  opts: { seconds?: boolean } = {},
): string | null {
  const dt = DateTime.fromISO(iso, { zone });
  if (!dt.isValid) return null;
  const abbr = zoneAbbreviation(iso, zone);
  const clock = formatClockTime(dt);
  if (!abbr || !clock) return null;
  // Seconds go beside the minutes rather than at the end (#1943), so the stamp
  // still reads as one time: "11:03:41am", not "11:03am:41".
  const time = opts.seconds
    ? clock.replace(/^(\d+:\d{2})/, `$1:${String(dt.second).padStart(2, "0")}`)
    : clock;
  return `${formatSlotDay(iso, zone)}, ${time} ${abbr}`;
}

/**
 * The zone's short name AT that instant, e.g. `MST`, `EDT`, `EST`, `UTC`.
 *
 * At the instant, because the same zone is `EST` in January and `EDT` in July.
 * A zone the runtime has no abbreviation for answers its offset (`GMT+9`),
 * which is still a label a reader can use.
 */
export function zoneAbbreviation(iso: string, zone: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(
      new Date(ms),
    );
    return parts.find((p) => p.type === "timeZoneName")?.value ?? null;
  } catch {
    // An unknown zone id throws a RangeError; there is no label to give.
    return null;
  }
}
