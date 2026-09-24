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
 * A value outside the list is answered EXPLICITLY rather than by leaving the
 * control blank or letting it land on whatever happens to be first. Both are
 * real hazards: blank hides that a choice is needed, and silently selecting the
 * first option MOVES somebody's working hours without telling them, which on the
 * roster is somebody's real day.
 *
 * `wasOutsideList` exists so a caller can SAY so. It is false for an empty or
 * missing value, which is somebody who has simply not chosen yet rather than
 * somebody whose choice is no longer offered; telling those two apart is the
 * difference between a default and a silent overwrite.
 */
export function resolveZone(zone: string | undefined): {
  id: string;
  wasOutsideList: boolean;
} {
  if (zone && CURATED_ZONES.some((z) => z.id === zone)) {
    return { id: zone, wasOutsideList: false };
  }
  return { id: FALLBACK_ZONE, wasOutsideList: Boolean(zone && zone.length > 0) };
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
