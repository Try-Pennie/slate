import { groupRulesBySchedule, isUnsetHours, type HoursSource, type UnsetHoursSchedule } from "@/lib/monitor/unset-hours";
import type { OrgDefaults } from "@/lib/schedule-core";
import { selectAllPages } from "@/lib/supabase/paginate";
import { unwrap } from "@/lib/db/result";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import type { RosterHours } from "@/lib/admin/roster-filter";

/**
 * Whether each agent's working hours are still the seeded default (#1802).
 *
 * Slate records this: `availability_schedules.hours_source` names who last wrote
 * a week (migration 0117, #1753), and for a row written before the stamp existed
 * the store's own shape decides. `isUnsetHours` holds that rule and is what the
 * unset hours alert and the activation import already use, so the roster reads the
 * same answer they do rather than a second opinion.
 *
 * A user with no schedule row is absent from the map; the caller shows them as
 * `none`, because a missing week and an empty one are the same thing to a lead.
 */
export function rosterHoursByUser(schedules: UnsetHoursSchedule[], org: OrgDefaults): Map<string, RosterHours> {
  const out = new Map<string, RosterHours>();
  for (const s of schedules) {
    out.set(s.user_id, s.rules.length === 0 ? "none" : isUnsetHours(s, org) ? "seeded" : "set");
  }
  return out;
}

type Db = ReturnType<typeof supabaseAdmin>;

/**
 * The hours state for these users. THROWS on any read it could not make: the page
 * catches that and shows no hours column, because an unreadable schedule shown as
 * `none` would tell an operator nobody has hours (L10, #1165).
 */
export async function loadRosterHours(db: Db, orgId: string, userIds: string[]): Promise<Map<string, RosterHours>> {
  if (userIds.length === 0) return new Map();
  const [orgRow, scheds] = await Promise.all([
    db
      .from("organizations")
      .select("default_timezone, default_start_minute, default_end_minute, default_weekdays")
      .eq("id", orgId)
      .maybeSingle(),
    // One schedule per user, the roster bounded at about 200, so the id list stays
    // inside the PostgREST URL limit; paged anyway, since it costs nothing.
    selectAllPages<{
      id: string;
      user_id: string;
      timezone: string;
      hours_source: HoursSource | null;
      hours_set_at: string | null;
      created_at: string;
    }>("roster hours schedules", "id", () =>
      db
        .from("availability_schedules")
        .select("id, user_id, timezone, hours_source, hours_set_at, created_at")
        .in("user_id", userIds),
    ),
  ]);
  const org = unwrap(orgRow, "roster hours org defaults") as OrgDefaults | null;
  if (!org) throw new Error("roster hours: no organization row");
  const rules =
    scheds.length === 0
      ? []
      : await selectAllPages<{ schedule_id: string; weekday: number; start_minute: number; end_minute: number }>(
          "roster hours rules",
          "id",
          () =>
            db
              .from("availability_rules")
              .select("id, schedule_id, weekday, start_minute, end_minute")
              .in("schedule_id", scheds.map((s) => s.id)),
        );
  const rulesBySchedule = groupRulesBySchedule(rules);
  const byUser = rosterHoursByUser(
    scheds.map((s) => ({ ...s, rules: rulesBySchedule.get(s.id) ?? [] })),
    org,
  );
  for (const id of userIds) if (!byUser.has(id)) byUser.set(id, "none");
  return byUser;
}
