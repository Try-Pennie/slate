import type { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";

export interface WorkingHoursSchedule {
  id: string;
  user_id: string;
  timezone: string;
}

export interface WorkingHoursRule {
  schedule_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
}

/**
 * The whole roster's working hours (schedules + their rules), each read paged
 * past PostgREST's 1,000-row cap (#828). The availability monitor joins these
 * two whole-table reads in JS for its on-shift gate; at ~5-7 rules per schedule
 * × ~200 agents the rules table alone is ~1,000-1,400 rows, so a single-page
 * read would silently drop working hours and mis-fire the gate. Throws on a read
 * error (via selectAllPages) rather than degrading to a short list.
 */
export async function loadAllWorkingHours(
  db: ReturnType<typeof supabaseAdmin>,
): Promise<{ schedules: WorkingHoursSchedule[]; rules: WorkingHoursRule[] }> {
  const [schedules, rules] = await Promise.all([
    selectAllPages<WorkingHoursSchedule>("availability_schedules", "id", () =>
      db.from("availability_schedules").select("id, user_id, timezone"),
    ),
    selectAllPages<WorkingHoursRule>("availability_rules", "id", () =>
      db
        .from("availability_rules")
        .select("id, schedule_id, weekday, start_minute, end_minute"),
    ),
  ]);
  return { schedules, rules };
}
