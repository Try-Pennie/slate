import { supabaseAdmin } from "@/lib/supabase/admin";
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
