import { DateTime } from "luxon";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { loadBusinessHoursCached } from "@/lib/booking/business-hours-load";
import { readBookingHorizonDays, readProgramLeadTimesSettings } from "@/lib/booking/settings";
import { readProgramLeadTimesToken } from "@/lib/booking/program-lead-gate";
import { programLeadTimes, type ProgramLeadTimes, type ProgramLeadTimesDeps } from "./program-lead-times";

/**
 * The live wiring of a program lead's times (#4390): the rules are `program-lead-times.ts`;
 * this binds them to the token secret, `booking_settings`, the cached week, the horizon,
 * `placeholder_day_counts` (0213), or for a move `placeholder_day_held` per day with the
 * moving booking left out (#4414), and `bump_program_lead_outcome` (0215). Server only.
 *
 * A fallback is logged by its reason, never with the token, and COUNTED; a count that
 * fails is logged as an error of its own, since it is the one failure nothing else sees.
 */
const LIVE_DEPS: ProgramLeadTimesDeps = {
  readToken: (token) => {
    const reading = readProgramLeadTimesToken(token);
    if (!reading.ok) return { ok: false, reason: reading.reason };
    return { ok: true, movingBookingId: reading.facts.purpose === "move" ? reading.facts.bookingId : null };
  },
  readSettings: readProgramLeadTimesSettings,
  loadHours: loadBusinessHoursCached,
  readHorizonDays: readBookingHorizonDays,
  readDayCounts: async (fromDay, toDay, excludeBookingId) => {
    // #4414: a move reads each day through the one predicate with the moving booking left
    // out, so a call already on a full day's placeholder can still move within it. The
    // horizon is a few days and moves are rare, so one small read per day is fine here.
    if (excludeBookingId !== null) {
      const days: string[] = [];
      for (let d = DateTime.fromISO(fromDay); d.toISODate()! <= toDay; d = d.plus({ days: 1 })) days.push(d.toISODate()!);
      const held = await Promise.all(
        days.map(async (day) => {
          const n = unwrap(
            await supabaseAdmin().rpc("placeholder_day_held", { p_day: day, p_exclude_booking: excludeBookingId }),
            "placeholder_day_held",
          ) as number | null;
          if (!Number.isInteger(n)) throw new Error(`placeholder_day_held answered no count for ${day}`);
          return [day, n as number] as const;
        }),
      );
      return new Map(held);
    }
    // One row per day of the range, the horizon's few days, never a growth read.
    const rows = unwrap(
      await supabaseAdmin().rpc("placeholder_day_counts", { p_from: fromDay, p_to: toDay }),
      "placeholder_day_counts",
    ) as { call_day: string; held: number }[] | null;
    const out = new Map<string, number>();
    for (const row of rows ?? []) {
      if (typeof row.call_day === "string" && Number.isInteger(row.held)) out.set(row.call_day, row.held);
    }
    return out;
  },
  countFallback: async () => {
    const { error } = await supabaseAdmin().rpc("bump_program_lead_outcome", { p_kind: "times_fallback" });
    if (error) throw new Error(`bump_program_lead_outcome failed: ${error.message}`);
  },
  now: () => Date.now(),
};

export async function programLeadTimesLive(input: Parameters<typeof programLeadTimes>[0]): Promise<ProgramLeadTimes> {
  const out = await programLeadTimes(input, LIVE_DEPS);
  if (out.outcome.startsWith("fallback:")) {
    log.error("program-lead-times", {
      msg: "a program lead was shown real times only because a read failed",
      reason: out.outcome.slice("fallback:".length),
    });
    if (out.countFailed !== undefined) {
      log.error("program-lead-times", { msg: "and the fallback could not be counted" }, out.countFailed);
    }
  }
  return out;
}
