// Timezone picker options for the booker (#172). Pure + framework-free so the
// node-native test can import it. The booked instant is always a correct UTC
// value; this list only drives which local label the lead sees.

export interface TimezoneOption {
  /** IANA id, e.g. "America/New_York". */
  id: string;
  /** Human label shown in the <select>. */
  label: string;
}

/**
 * The zones anybody can pick, agent or lead. US ONLY (#1849).
 *
 * Dan's call, asked and answered: Pennie's leads are US debt customers and the
 * roster is US staff. This DELIBERATELY narrows #172 and #219, which carried
 * London, Central Europe and UTC for a travelling lead, and it gives something
 * up rather than costing nothing.
 *
 * WHAT IT GIVES UP: a lead whose browser reports a non US zone is shown times in
 * Eastern rather than in their own. Nothing is mis-booked, because the stored
 * instant is always UTC. What breaks is what they READ, and they have no way to
 * notice, which is why it is written here rather than left to be discovered.
 *
 * The fixed list is also what fixed the menu that covered the screen: it used to
 * be these plus every zone the runtime knows, several hundred rows, in a control
 * the platform drew and our CSS could not bound.
 */
export const CURATED_ZONES: readonly TimezoneOption[] = [
  { id: "America/New_York", label: "Eastern time (New York)" },
  { id: "America/Chicago", label: "Central time (Chicago)" },
  { id: "America/Denver", label: "Mountain time (Denver)" },
  { id: "America/Phoenix", label: "Arizona (Phoenix)" },
  { id: "America/Los_Angeles", label: "Pacific time (Los Angeles)" },
  { id: "America/Anchorage", label: "Alaska (Anchorage)" },
  { id: "Pacific/Honolulu", label: "Hawaii (Honolulu)" },
];

/** The zone a device or stored zone outside the list resolves to. Also the zone
 *  the lead's calling window judges an unreadable zone in (#2310). */
export const FALLBACK_ZONE = "America/New_York";

/**
 * The device's resolved IANA timezone (e.g. "America/New_York"), or the fallback
 * zone when Intl is unavailable (SSR, or a runtime without the Intl API). Shared
 * by the booker and the manage-booking screen so detection lives in one place.
 */
export function deviceTimeZone(): string {
  return typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : FALLBACK_ZONE;
}

/**
 * A zone as a person reads it: the picker's own label for a listed zone
 * ("Hawaii (Honolulu)"), else the humanised city, so a stored zone outside the
 * list still reads as a place rather than an IANA id (#2310).
 */
export function zoneLabel(id: string): string {
  return CURATED_ZONES.find((z) => z.id === id)?.label ?? humanizeZone(id);
}

/** "Australia/Sydney" -> "Sydney"; "UTC" -> "UTC". */
export function humanizeZone(id: string): string {
  const segment = id.split("/").pop() ?? id;
  return segment.replace(/_/g, " ");
}

/**
 * The picker's options. Always the US list, whatever was detected (#1849).
 *
 * It used to prepend an uncurated detected zone so a travelling lead kept their
 * own. With a fixed list that is exactly what must not happen, or the list is
 * not fixed. WHICH option is selected is `resolveZone`'s job, and the two being
 * separate is the point: a list that quietly grew by one is how ten agents held
 * uncurated zones for months without anybody deciding to allow them.
 */
export function timezoneOptions(): TimezoneOption[] {
  return [...CURATED_ZONES];
}

/**
 * Which option a stored or detected zone selects, and whether it had to fall
 * back (#1849).
 *
 * A zone that keeps the same clock as a listed one under another name
 * (`America/Boise` keeps Denver's clock, `America/Indiana/Indianapolis` and
 * `America/Detroit` keep New York's, `America/Juneau` keeps Anchorage's) selects
 * that listed zone, and is NOT a fallback: every time it shows reads exactly as
 * it would in the person's own zone, so nothing about their day moved (#2687).
 * The mapping is derived by comparing the clocks hour by hour
 * (`sameClockListedZone`), never kept as a hand list, so a zone nobody thought
 * of is covered and a zone whose rules change stops mapping when they do.
 *
 * A value that keeps no listed clock is answered EXPLICITLY rather than by
 * leaving the control blank or letting it land on whatever happens to be first.
 * Both are real hazards: blank hides that a choice is needed, and silently
 * selecting the first option MOVES somebody's working hours without telling
 * them, which on the roster is somebody's real day.
 *
 * `wasOutsideList` exists so a caller can SAY so. It is false for an empty or
 * missing value, which is somebody who has simply not chosen yet rather than
 * somebody whose choice is no longer offered; telling those two apart is the
 * difference between a default and a silent overwrite.
 */
export function resolveZone(
  zone: string | undefined,
  nowMs: number = Date.now(),
): {
  id: string;
  wasOutsideList: boolean;
} {
  if (!zone) return { id: FALLBACK_ZONE, wasOutsideList: false };
  if (CURATED_ZONES.some((z) => z.id === zone)) {
    return { id: zone, wasOutsideList: false };
  }
  const sameClock = sameClockListedZone(zone, nowMs);
  if (sameClock) return { id: sameClock, wasOutsideList: false };
  return { id: FALLBACK_ZONE, wasOutsideList: true };
}

/**
 * How far ahead two zones are compared, and how finely (#2687).
 *
 * 400 days covers both of a zone's clock changes plus the weeks a year when one
 * of two zones has changed and the other has not, which is the window a shorter
 * check would sail through. Hourly, because a divergence lasting less than a day
 * (two zones changing on the same date at different local hours) is still a
 * lead shown the wrong time.
 */
export const ZONE_SAMPLE_HOURS = 400 * 24;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** One formatter per zone, or null for a zone this runtime cannot read. */
const wallClockFormatters = new Map<string, Intl.DateTimeFormat | null>();

function wallClockFormatter(zone: string): Intl.DateTimeFormat | null {
  const hit = wallClockFormatters.get(zone);
  if (hit !== undefined) return hit;
  let f: Intl.DateTimeFormat | null;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
  } catch {
    f = null;
  }
  wallClockFormatters.set(zone, f);
  return f;
}

/** Minutes the zone's wall clock sits ahead of UTC at `ms` (a whole minute). */
function offsetMinutes(f: Intl.DateTimeFormat, ms: number): number {
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(ms)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  // `% 24`: an engine that prints midnight as "24" still means hour zero of the
  // day it printed.
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute);
  return Math.round((wall - ms) / 60_000);
}

/** Memoised on the WHOLE input, the day included, because the answer depends on
 *  the zone rules in force from that day and legislation can change them. A key
 *  without the day would be fast and silently wrong the year one moved (L573). */
const sameClockCache = new Map<string, boolean>();

/**
 * Whether two zone names keep the same clock at every hour of the next
 * `ZONE_SAMPLE_HOURS` from `nowMs` (#2687).
 *
 * This is the ONE judge of "the same clock under another name": the cal.com
 * parity check (`zonesAgree` in `scripts/lib/schedule-parity.ts`) asks it too,
 * so the booker and the parity report cannot disagree about whether Boise is
 * Denver.
 *
 * It asks the runtime's own zone data, which on a lead's device is the same
 * data that renders the times they read, so a device is judged by the rules it
 * will actually show.
 *
 * A zone the runtime cannot read never agrees with anything, itself included:
 * answering true there would pass a broken value off as an alias.
 *
 * Cost: a mismatch usually shows at the first hour and returns at once; a real
 * match walks the whole window (about 19,000 formatted instants, tens of
 * milliseconds), once per pair per day per process thanks to the memo.
 */
export function zonesKeepSameClock(a: string, b: string, nowMs: number = Date.now()): boolean {
  const day = Math.floor(nowMs / DAY_MS);
  const key = `${a}|${b}|${day}`;
  const hit = sameClockCache.get(key);
  if (hit !== undefined) return hit;

  const fa = wallClockFormatter(a);
  const fb = wallClockFormatter(b);
  let same = fa !== null && fb !== null;
  if (same && a !== b) {
    const start = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    for (let h = 0; same && h < ZONE_SAMPLE_HOURS; h++) {
      const t = start + h * HOUR_MS;
      if (offsetMinutes(fa!, t) !== offsetMinutes(fb!, t)) same = false;
    }
  }
  sameClockCache.set(key, same);
  return same;
}

/**
 * The listed zone that keeps exactly the same clock as `zone`, or null (#2687).
 *
 * Exactly one, or none. No two listed zones share a clock today, but if a change
 * to the list ever made them, choosing either would be a guess, so a zone
 * matching two is answered as matching none. A zone matching a listed clock for
 * only PART of the window (Regina and Mexico City keep Chicago's clock all winter
 * and not in summer) is not the same clock and does not map.
 */
export function sameClockListedZone(zone: string, nowMs: number = Date.now()): string | null {
  const matches = CURATED_ZONES.filter((z) => zonesKeepSameClock(zone, z.id, nowMs));
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * #1849 REMOVED `allTimeZones`, `isKnownTimeZone` and `ensureZonePresent`.
 *
 * All three served the "more zones" combobox (#219), which let anybody reach a
 * zone outside the curated list. A fixed US list is the decision, so a mechanism
 * for escaping it is not a smaller version of that decision, it is the opposite
 * of it. Deleted rather than left unused, because a helper with no callers and a
 * docstring explaining why it is needed is what the next reader argues with
 * instead of removing (L29).
 */
