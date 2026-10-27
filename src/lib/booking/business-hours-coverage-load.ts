/**
 * The reads behind `coverageForWeek` (#1297), in one place (#1454).
 *
 * Two surfaces now ask the same question, "for each hour the org is open, how many
 * bookable agents are rostered": the business hours editor, which shows it, and the
 * monitor lane, which alarms on it. The assembly is not trivial (the pool is the
 * intersection of three flags, the rules arrive as a separate paged table, and an
 * agent with no schedule row still counts toward the denominator), so a second copy
 * would drift, and the screen and the alarm would start disagreeing about who covers
 * what while each looked correct alone (L107).
 *
 * The read THROWS on failure rather than returning an empty pool, and every caller
 * must keep that distinction: an unreadable roster scored as "nobody covers this"
 * reads as a staffing problem someone would go and fix, and on the lane it would page
 * exactly the finding this check exists to report. `coverageForWeek` takes `agents:
 * null` for that state and returns `{ ok: false }` carrying no counts at all.
 */
import { DateTime } from "luxon";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { realAdvisorsOnly } from "@/lib/advisors/real-advisor";
import { loadAllWorkingHours } from "@/lib/availability/working-hours-load";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import type { CoverageAgent } from "@/lib/booking/business-hours-coverage";

/**
 * Every agent who could actually take a booking, with their own zone and rules.
 *
 * "Bookable" is the intersection of three flags, not the one named `bookable`.
 * Measured 2026-08-06: 13 users carry that flag and 11 of them are deactivated
 * leavers whose flag was never cleared, so counting it alone overstates the pool
 * by 11 and every coverage figure inherits the error.
 */
export async function loadCoverageAgents(
  db: ReturnType<typeof supabaseAdmin>,
): Promise<(CoverageAgent & { userId: string })[]> {
  const { data: pool, error } = await realAdvisorsOnly(
    db.from("users").select("id").eq("bookable", true).is("deactivated_at", null),
  );
  if (error) throw new Error(`coverage pool read failed: ${error.message}`);
  const poolIds = ((pool ?? []) as { id: string }[]).map((u) => u.id);

  const { schedules, rules } = await loadAllWorkingHours(db);
  const rulesBySchedule = new Map<
    string,
    { weekday: number; start_minute: number; end_minute: number }[]
  >();
  for (const r of rules) {
    const list = rulesBySchedule.get(r.schedule_id) ?? [];
    list.push({ weekday: r.weekday, start_minute: r.start_minute, end_minute: r.end_minute });
    rulesBySchedule.set(r.schedule_id, list);
  }
  const scheduleByUser = new Map(schedules.map((sch) => [sch.user_id, sch]));

  // One entry per pool member, keyed by who they are, so a caller that joins
  // per-agent facts on (approved time off, #1582) attaches them to the right
  // person. An agent with no schedule row still counts: they are bookable, they
  // just cover nothing. Dropping them would shrink the denominator and make a
  // half-rostered pool look fully staffed.
  return poolIds.map((userId) => {
    const sch = scheduleByUser.get(userId);
    return {
      userId,
      timezone: sch?.timezone ?? BUSINESS_ZONE,
      rules: sch ? (rulesBySchedule.get(sch.id) ?? []) : [],
    };
  });
}

/** The Monday of the current week in the org's zone, as `coverageForWeek` wants it.
 *  A concrete week, so a real zone offset and that week's DST actually apply. */
export function currentWeekStartIso(zone: string = BUSINESS_ZONE): string {
  return DateTime.now().setZone(zone).startOf("week").toISODate() ?? "2026-01-05";
}
