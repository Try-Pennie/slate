/**
 * The IO half of the race whisper (#2838), kept out of `race-contention.ts` so
 * that module stays node testable with no `@/` imports.
 *
 * ONE READ, and it THROWS rather than degrading. A failed tally read that came
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
import { raceWindowFromMix, type RaceContentionWindow } from "@/lib/monitor/race-contention";

/** Today's race counts, on the tally's own Eastern day boundary. */
export async function readRaceContentionWindow(nowMs: number): Promise<RaceContentionWindow> {
  const day = DateTime.fromMillis(nowMs, { zone: OUTCOME_DAY_ZONE }).toISODate() ?? "";
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
