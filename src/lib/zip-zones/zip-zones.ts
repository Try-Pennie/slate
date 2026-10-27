/**
 * A customer's time zone from their Salesforce Lead (#4205). The Lead holds no zone,
 * but its `PostalCode` and `State` are filled (20 of 20 sampled, 2026-10-26), so:
 *
 *   1. the zip, through the table generated from GeoNames (`zip-zone-data.ts`, see
 *      `scripts/generate-zip-zones.ts`), which splits Texas, Florida, Indiana and the
 *      rest at the zip, and keeps Arizona off daylight saving and the Navajo Nation on it;
 *   2. else the state, only where every zip in it keeps one clock;
 *   3. else no zone, which the coordinator page refuses by name.
 *
 * NEVER Eastern by default. `FALLBACK_ZONE` (`booking/timezones.ts`) is the booker's
 * answer for a device it cannot read, and booking a Phoenix or Honolulu customer at an
 * Eastern hour is the mistake this exists to prevent.
 *
 * Server only: the table is about 11 KB, and `scripts/test-client-admin-reach.ts` holds
 * every client component's import graph away from it. No `@/` imports, so node runs it.
 */
import { STATE_ZONES, ZIP_ZONE_MIXED, ZIP_ZONE_NAMES, ZIP_ZONE_PREFIXES } from "./zip-zone-data.ts";

/** One character per zone name, in `ZIP_ZONE_NAMES` order (`scripts/lib/zip-zone-compact.ts`). */
export const ZONE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** A three digit prefix whose zips do not share one zone: each is listed in the mixed records. */
export const MIXED_PREFIX = "*";
/** A three digit prefix with no known zip. */
export const NO_PREFIX = ".";

const MIXED_RECORD = 6;

/** Decode one zip against a compact table; null when the table cannot say. */
export function decodeZipZone(zones: readonly string[], prefixes: string, mixed: string, zip: string): string | null {
  if (!/^\d{5}$/.test(zip)) return null;
  const c = prefixes[Number(zip.slice(0, 3))];
  if (c === undefined || c === NO_PREFIX) return null;
  if (c !== MIXED_PREFIX) return zones[ZONE_ALPHABET.indexOf(c)] ?? null;
  // Binary search over the fixed width, sorted records.
  let lo = 0;
  let hi = mixed.length / MIXED_RECORD - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = mid * MIXED_RECORD;
    const key = mixed.slice(at, at + 5);
    if (key === zip) return zones[ZONE_ALPHABET.indexOf(mixed[at + 5])] ?? null;
    if (key < zip) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/**
 * A Lead's `PostalCode` as five digits, or null. ZIP+4 (with or without its dash) is
 * its first five; four digits are a New England or New Jersey zip whose leading zero a
 * spreadsheet dropped, and get it back. Anything else (letters, a Canadian code, three
 * digits) is no zip.
 */
export function normaliseZip(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (/^\d{5}(?:[-\s]?\d{4})?$/.test(v)) return v.slice(0, 5);
  if (/^\d{4}$/.test(v)) return `0${v}`;
  return null;
}

/** The zone of a five digit zip, or null when the table cannot say. */
export function zoneForZip(zip: string): string | null {
  return decodeZipZone(ZIP_ZONE_NAMES, ZIP_ZONE_PREFIXES, ZIP_ZONE_MIXED, zip);
}

/** The zone of a two letter state code, only for a state every zip of which keeps one clock. */
export function zoneForState(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return Object.hasOwn(STATE_ZONES, code) ? STATE_ZONES[code] : null;
}

export type LeadZone = { ok: true; zone: string; from: "zip" | "state" } | { ok: false };

/** The customer's zone from the Lead's zip, then its state, or no zone. Never a default. */
export function leadZone(lead: { postalCode: string | null; state: string | null }): LeadZone {
  const zip = normaliseZip(lead.postalCode);
  const byZip = zip === null ? null : zoneForZip(zip);
  if (byZip !== null) return { ok: true, zone: byZip, from: "zip" };
  const byState = zoneForState(lead.state);
  if (byState !== null) return { ok: true, zone: byState, from: "state" };
  return { ok: false };
}
