import { supabaseAdmin } from "@/lib/supabase/admin";
import { makeCachedHoursReader } from "@/lib/booking/business-hours-cache";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import {
  resolveBusinessHours,
  BUSINESS_ZONE,
  type BusinessHoursRow,
  type BusinessWindow,
} from "@/lib/booking/business-hours";

/**
 * Read the org's business hours (#1294). The resolution rules, and why they are
 * asymmetric, live in `business-hours.ts`; this is the thin DB layer.
 *
 * THROWS on a read error, deliberately, unlike `loadBookingHorizonDays` next door
 * which degrades to its default. The difference is which way each one fails: a
 * missing horizon serves the standard four days, while a missing business-hours
 * answer would have to either close the org (blanking the booker) or fall back to
 * the seeded week, and falling back would silently re-open hours an admin had
 * narrowed. Neither is acceptable to decide down here, so the caller is told.
 *
 * A read that succeeds and returns NO rows is not an error: that is an unconfigured
 * table, which resolves to the seeded week and logs, so a fresh database still
 * offers times.
 */
export interface BusinessHours {
  zone: string;
  /** Open windows only, one per open weekday, in the agent-rule shape. */
  rules: BusinessWindow[];
  /** Whether this came from the store or from the coded fallback. */
  source: "stored" | "seeded";
}

/**
 * The RAW seven rows, including closed days and their (unused) windows (#1297).
 *
 * `loadBusinessHours` above returns only the OPEN windows, because that is all the
 * gate needs. The editor needs more: which days are currently open, so it can tell a
 * day being newly closed from one already shut, and a closed day's stored window, so
 * re-opening it restores the hours it had rather than inventing new ones.
 *
 * Returns an empty array for an unconfigured table; the caller renders the seeded
 * week. Throws on a read error, like its sibling.
 */
export async function loadBusinessHoursRows(): Promise<BusinessHoursRow[]> {
  const db = supabaseAdmin();
  // cap-safe: business_hours holds exactly one row per weekday, a fixed 1..7 key
  // space, so it can never exceed a page.
  return (unwrap(
    await db
      .from("business_hours")
      .select("weekday, is_open, start_minute, end_minute")
      .order("weekday"),
    "business_hours",
  ) ?? []) as BusinessHoursRow[];
}

export async function loadBusinessHours(): Promise<BusinessHours> {
  const db = supabaseAdmin();
  // cap-safe: business_hours holds exactly one row per weekday, a fixed 1..7 key
  // space, so it can never exceed a page.
  const rows = (unwrap(
    await db.from("business_hours").select("weekday, is_open, start_minute, end_minute"),
    "business_hours",
  ) ?? []) as BusinessHoursRow[];

  const resolved = resolveBusinessHours(rows);
  if (!resolved.ok) {
    // A stored week we cannot trust is not something to paper over: widening hours
    // an admin narrowed is invisible in the product (the booker just keeps offering
    // the old times), so this fails loudly like a read error.
    throw new Error(`business hours are unusable: ${resolved.error}`);
  }
  if (resolved.source === "seeded") {
    log.warn("business-hours", {
      msg: "no stored week; using the seeded default",
      rows: rows.length,
    });
  }
  return { zone: BUSINESS_ZONE, rules: resolved.rules, source: resolved.source };
}

/**
 * How long a successful hours read stays fresh in one isolate (#1296).
 *
 * Aligned to `SLOT_TTL_SECONDS` in `src/lib/availability/slot-cache.ts`: the read
 * path already tolerates 5 seconds of slot staleness, so the hours that FILTER
 * those slots must not be staler than the slots themselves. It is duplicated
 * rather than imported because importing slot-cache here would close a cycle
 * (slot-cache imports the availability service, which imports this module).
 * `scripts/test-business-hours-ttl.ts` fails the build if the two drift apart.
 */
export const BUSINESS_HOURS_TTL_MS = 5_000;

/**
 * The read the hot path uses. Same answer as `loadBusinessHours`, at one round trip
 * per isolate per TTL instead of one per request.
 *
 * On a failed refresh it serves the LAST KNOWN week rather than failing the request
 * (Dan, 2026-08-06), so a blip cannot stop leads booking. That stays honest because
 * a sustained failure is loud on the WRITE side: `getBucketSlots` throws, no row is
 * written, and `bucket_slots_stale` pages after six minutes. Each stale serve is
 * logged with its age, so the window is visible rather than inferred.
 *
 * A cold isolate whose FIRST read fails still throws: there is no last known week,
 * and inventing one could silently re-open hours an admin had narrowed.
 */
export const loadBusinessHoursCached = makeCachedHoursReader({
  load: loadBusinessHours,
  ttlMs: BUSINESS_HOURS_TTL_MS,
  now: () => Date.now(),
  // Warn, not error: a failed refresh serves the last known week and a sustained
  // failure stops recompute writing, which pages separately. The Error goes
  // through (#1188) so the stack says WHERE the read broke.
  onStale: (ageMs, err) =>
    log.warn(
      "business-hours",
      { msg: "serving the last known week; refresh failed", age_ms: ageMs },
      err,
    ),
});
