/**
 * The one loader for the Days offered settings (#3922).
 *
 * `booking_settings.offered_open_days` (migration 0190) is how many open days every
 * lead is offered; it was the constant `OFFERED_OPEN_DAYS = 3` until Dan asked to
 * change it himself. Everything that used the constant reads it through here:
 *
 * - the booker's offered window (`slot-cache.ts`), through the CACHED read below;
 * - the bucket availability page and its copy (`bucket-supply-load.ts`), the
 *   monitor's tier staffing and nearly full checks, and the Hours page's card,
 *   through the HONEST read.
 *
 * WHICH WAY A FAILED READ GOES, chosen from the rules already in AGENTS.md rather
 * than invented here:
 *
 * - A MEASURING caller gets `null`, never a default (#1654): the horizon's rule. A
 *   window built from a guessed day count would change what a reading MEANS while
 *   looking normal, so the supply page says it could not check and the monitor
 *   judges no tier rather than judging one against a guessed window (L215).
 * - The BOOKER keeps the LAST value this isolate read, on the business hours' terms
 *   (#1296, Dan 2026-08-06): the same TTL, so an edit lands within seconds, and a
 *   blip cannot change what leads are offered. A default would: with 4 saved, a
 *   failed refresh answering 3 would quietly take a day off every lead's strip.
 * - A cold isolate whose FIRST read fails throws, as the hours reader does, and the
 *   booker's caller maps that to "the offered window could not be measured", the
 *   one documented degradation it already has for an unreadable week: it serves the
 *   stored rows, which reach the horizon, so a lead is shown MORE days rather than
 *   fewer and never a number nobody saved. That path is logged on every request.
 *   A SUSTAINED failure of this row is loud elsewhere: the monitor lane's horizon
 *   setup read is the same row, and a failing setup read pages (#2382).
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import type { BookingSettings } from "@/lib/db/types";
import { makeCachedHoursReader } from "@/lib/booking/business-hours-cache";
import { horizonFromStored } from "@/lib/booking/settings";
import { resolveOfferedOpenDays } from "@/lib/booking/days-offered";

export interface DaysOfferedReading {
  /** How many open days every lead is offered. */
  offeredOpenDays: number;
  /** The last resort's reach, offered plus extra, resolved as every horizon reader resolves it. */
  horizonDays: number;
}

/** One read of both columns, THROWING on any failure. */
async function loadDaysOffered(): Promise<DaysOfferedReading> {
  const row = unwrap(
    await supabaseAdmin()
      .from("booking_settings")
      .select("offered_open_days, horizon_days")
      .eq("id", 1)
      .maybeSingle(),
    "booking_settings.offered_open_days",
  ) as Pick<BookingSettings, "offered_open_days" | "horizon_days"> | null;
  return {
    offeredOpenDays: resolveOfferedOpenDays(row?.offered_open_days),
    horizonDays: horizonFromStored(row?.horizon_days ?? null),
  };
}

/**
 * Both settings, or **null** when the read failed. Null means the READ failed;
 * a missing row is the column defaults, which is a real answer (L214).
 */
export async function readDaysOffered(): Promise<DaysOfferedReading | null> {
  try {
    return await loadDaysOffered();
  } catch (err) {
    log.error("days-offered", { msg: "days offered read failed" }, err);
    return null;
  }
}

/** The offered open days for a caller that MEASURES against them, or null. */
export async function readOfferedOpenDays(): Promise<number | null> {
  return (await readDaysOffered())?.offeredOpenDays ?? null;
}

/**
 * How long one read stands in an isolate on the booker's path. The business hours'
 * TTL (`BUSINESS_HOURS_TTL_MS`), because the two are applied together to cut the
 * same strip and an edit to either should land on the same request. Written out
 * rather than imported, so a suite that mocks the hours loader does not lose this
 * module with it; `days-offered-load.test.ts` holds the two equal.
 */
export const OFFERED_DAYS_TTL_MS = 5_000;

/** The booker's reader, with its read, clock and stale report injected. */
export function makeOfferedOpenDaysReader(deps: {
  read: () => Promise<number>;
  now: () => number;
  onStale: (ageMs: number, err: unknown) => void;
}): () => Promise<number> {
  return makeCachedHoursReader<number>({
    load: deps.read,
    ttlMs: OFFERED_DAYS_TTL_MS,
    now: deps.now,
    onStale: deps.onStale,
  });
}

/**
 * The booker's read: one round trip per isolate per TTL, the last known value
 * through a failed refresh, and a throw when there is none. See the header.
 */
export const loadOfferedOpenDaysCached = makeOfferedOpenDaysReader({
  read: async () => (await loadDaysOffered()).offeredOpenDays,
  now: () => Date.now(),
  // Warn, not error: the value served is the last one actually read, and each
  // stale serve carries its age so the window is visible in the logs.
  onStale: (ageMs, err) =>
    log.warn("days-offered", { msg: "serving the last known offered open days; refresh failed", age_ms: ageMs }, err),
});
