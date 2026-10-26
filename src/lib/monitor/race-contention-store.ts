/**
 * The IO half of the race whisper (#2838), kept out of `race-contention.ts` so
 * that module stays node testable with no `@/` imports.
 *
 * TWO READS, the day's tally on every tick and the busiest tier's bookings only
 * when the verdict can turn on them (#2877), and both THROW rather than degrading. A failed tally read that came
 * back as an empty day would read as "nobody lost a race", the healthy answer at
 * exactly the moment nothing was measured (#277, #1134, #1165), so `unwrap`
 * throws and a mix with no outcome map throws too; the step boundary then logs
 * the tick as failed and sends nothing.
 *
 * COST: one RPC per monitor tick, returning one jsonb row (cap safe by
 * construction), on the invocation four cron lanes share. The race counts ride on
 * the same aggregate the failure rate reads, so the smoke canary and off site
 * testers are left out by the same two flags, passed explicitly here for the same
 * reason `readTodayOutcomes` gives: the exclusion is visible where it is read.
 */
import { DateTime } from "luxon";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { OUTCOME_DAY_ZONE, type RawMix } from "@/lib/monitor/booking-api-outcome";
import { selectAllPages, sortByStamp } from "@/lib/supabase/paginate";
import { parseStampMs } from "@/lib/date/stamp";
import {
  createRaceThresholdCache,
  raceRateWindow,
  raceWindowFromMix,
  type RaceContentionWindow,
  type TierBooking,
} from "@/lib/monitor/race-contention";

/**
 * The measured race threshold for the current Eastern day, held for this isolate
 * so a qualifying day pages through the fortnight of bookings once rather than on
 * every monitor tick (PR #2883). Holds one day, so it never grows. A fresh isolate
 * measures again, which costs one read and changes nothing a day's median could.
 */
export const raceThresholdDayCache = createRaceThresholdCache();

/** Today's race counts, on the tally's own Eastern day boundary. */
export async function readRaceContentionWindow(nowMs: number): Promise<RaceContentionWindow> {
  // An unformattable clock must refuse, never become p_since "", which would ask
  // for a window nobody chose and report it as today.
  const day = DateTime.fromMillis(nowMs, { zone: OUTCOME_DAY_ZONE }).toISODate();
  if (!day) throw new Error(`could not name the Eastern day for ${String(nowMs)}, so nothing was read`);
  const raw = unwrap(
    await supabaseAdmin().rpc("booking_api_outcome_mix", {
      p_since: day,
      p_include_test: false,
      p_include_offsite: false,
    }),
    "booking_api_outcome_mix",
  ) as RawMix | null;
  const window = raceWindowFromMix(raw, day);
  if (!window) throw new Error("booking_api_outcome_mix answered, and its outcome counts could not be read");
  return window;
}

/**
 * Real routed bookings over `raceRateWindow(nowMs)` (the whole hours of the
 * `RACE_RATE_LOOKBACK_DAYS` before the hour under way), each with
 * its bucket code, for the busiest tier's rate (#2877).
 *
 * The same population the rest of the monitoring tree counts as customers: test
 * buckets (the smoke canary, the public test bucket) out through the bucket's
 * `is_test`, since `bookings` has none of its own, and routed bookings only, since
 * a booking through an agent's own link is not traffic the round robin carried.
 *
 * COST: paged, because a fortnight at full volume is well past one 1,000 row page,
 * and a truncated read would measure a slower tier than Slate carries. That is why
 * the lane asks for it only when the verdict can turn on it (`raceThresholdNeeded`).
 *
 * THROWS on a failed read and on a stamp it cannot read. An empty or shortened
 * list here would quietly pick the fallback or a lower rate, and the whisper would
 * then state a basis nobody measured.
 */
export async function readRaceRateBookings(nowMs: number): Promise<TierBooking[]> {
  if (!Number.isFinite(nowMs)) {
    throw new Error(`could not read the clock (${String(nowMs)}), so no booking window was asked for`);
  }
  // Whole hours at both ends, the same window the measurement counts.
  const win = raceRateWindow(nowMs);
  const sinceIso = new Date(win.sinceMs).toISOString();
  const untilIso = new Date(win.untilMs).toISOString();
  const db = supabaseAdmin();
  const rows = await selectAllPages<{ id: string; created_at: string; buckets: { code: string } | { code: string }[] | null }>(
    "race rate bookings",
    "id",
    () =>
      db
        .from("bookings")
        .select("id, created_at, buckets!inner(code, is_test)")
        .eq("buckets.is_test", false)
        .eq("kind", "routed")
        .gte("created_at", sinceIso)
        .lt("created_at", untilIso),
  ).then((r) => sortByStamp("race rate bookings", r, "created_at", "id"));
  return rows.map((r) => {
    const createdMs = parseStampMs(r.created_at);
    if (createdMs === null) throw new Error("race rate: a booking's created_at is unreadable");
    const bucket = Array.isArray(r.buckets) ? r.buckets[0] : r.buckets;
    return { createdMs, bucketCode: bucket?.code ?? null };
  });
}
