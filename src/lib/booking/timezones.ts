// Timezone picker options for the booker (#172). Pure + framework-free so the
// node-native test can import it. The booked instant is always a correct UTC
// value; this list only drives which local label the lead sees.

export interface TimezoneOption {
  /** IANA id, e.g. "America/New_York". */
  id: string;
  /** Human label shown in the <select>. */
  label: string;
}

// Curated common business zones, US-first (Pennie's leads are US debt
// customers), plus a few international ones a traveling lead might want.
export const CURATED_ZONES: readonly TimezoneOption[] = [
  { id: "America/New_York", label: "Eastern time (New York)" },
  { id: "America/Chicago", label: "Central time (Chicago)" },
  { id: "America/Denver", label: "Mountain time (Denver)" },
  { id: "America/Phoenix", label: "Arizona (Phoenix)" },
  { id: "America/Los_Angeles", label: "Pacific time (Los Angeles)" },
  { id: "America/Anchorage", label: "Alaska (Anchorage)" },
  { id: "Pacific/Honolulu", label: "Hawaii (Honolulu)" },
  { id: "Europe/London", label: "London" },
  { id: "Europe/Paris", label: "Central Europe (Paris)" },
  { id: "UTC", label: "UTC" },
];

const FALLBACK_ZONE = "America/New_York";

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

/** "Australia/Sydney" -> "Sydney"; "UTC" -> "UTC". */
export function humanizeZone(id: string): string {
  const segment = id.split("/").pop() ?? id;
  return segment.replace(/_/g, " ");
}

/**
 * The picker's options, guaranteed to contain `detected` so the <select value>
 * never renders blank. A detected zone outside the curated list (a traveling or
 * misconfigured lead, the #172 use case) is prepended with a humanized label so
 * they can still see and keep their own zone.
 */
export function timezoneOptions(detected: string | undefined): TimezoneOption[] {
  const zone = detected && detected.length > 0 ? detected : FALLBACK_ZONE;
  if (CURATED_ZONES.some((z) => z.id === zone)) return [...CURATED_ZONES];
  return [{ id: zone, label: humanizeZone(zone) }, ...CURATED_ZONES];
}

/**
 * The full IANA zone list for the "more zones" fallback combobox (#219), deduped.
 * Guarded: `Intl.supportedValuesOf` is widely but not universally available, so a
 * runtime without it degrades to [] and the booker keeps only the curated list.
 */
export function allTimeZones(): string[] {
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf;
    if (typeof supported !== "function") return [];
    return [...new Set(supported("timeZone"))];
  } catch {
    return [];
  }
}

/**
 * Whether `id` is a real IANA zone. Gates free-text combobox input so a typo or a
 * partial match can never apply a zone the runtime would reject (which would skew
 * the displayed local times). Uses Intl directly rather than the supportedValuesOf
 * list so it still validates on a runtime where that list is unavailable.
 */
export function isKnownTimeZone(id: string): boolean {
  if (!id) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: id });
    return true;
  } catch {
    return false;
  }
}

/**
 * `options` guaranteed to contain `zone`, prepending it (humanized) when absent.
 * Lets the curated <select> display a zone the lead picked from the full-list
 * combobox without the control blanking, since that zone isn't a curated option.
 */
export function ensureZonePresent(
  options: TimezoneOption[],
  zone: string,
): TimezoneOption[] {
  if (!zone || options.some((o) => o.id === zone)) return options;
  return [{ id: zone, label: humanizeZone(zone) }, ...options];
}
