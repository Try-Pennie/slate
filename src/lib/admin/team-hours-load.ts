/**
 * The reads behind the team hours view (#1757).
 *
 * Two failures, said separately, because they mean different things to the reader.
 * An unreadable ROSTER means nobody can be listed at all. Unreadable HOURS means
 * the people are known and their weeks are not, and drawing the list anyway would
 * put a row of "no hours" beside every name, which is the frightening reading and
 * the false one (#1629, #1647). So either failure withholds the whole table.
 *
 * The scope is applied IN the query for a manager, not only in the builder: a
 * manager's page never reads another team's rows at all.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { unwrap } from "@/lib/db/result";
import { selectAllPages } from "@/lib/supabase/paginate";
import type { OrgDefaults } from "@/lib/schedule-core";
import type { HoursSource } from "@/lib/monitor/unset-hours";
import {
  buildTeamHours,
  type TeamHoursAgent,
  type TeamHoursGroup,
  type TeamHoursSchedule,
  type TeamHoursScope,
} from "@/lib/admin/team-hours";

export type TeamHoursLoad =
  | { kind: "ok"; groups: TeamHoursGroup[] }
  | { kind: "unreadable"; what: "roster" | "hours" };

interface UserRow extends TeamHoursAgent {
  role: string;
  deactivated_at: string | null;
}

interface ScheduleRow {
  id: string;
  user_id: string;
  timezone: string;
  hours_source: HoursSource | null;
  hours_set_at: string | null;
  created_at: string;
}

interface RuleRow {
  schedule_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
}

export async function loadTeamHours(
  viewer: { id: string; org_id: string; name: string | null; email: string },
  scope: TeamHoursScope,
): Promise<TeamHoursLoad> {
  const db = supabaseAdmin();

  let agents: TeamHoursAgent[];
  const managers = new Map<string, string>();
  let org: OrgDefaults;
  try {
    const orgRow = unwrap(
      await db
        .from("organizations")
        .select("default_timezone, default_start_minute, default_end_minute, default_weekdays")
        .eq("id", viewer.org_id)
        .single(),
      "team hours org defaults",
    );
    if (!orgRow) return { kind: "unreadable", what: "roster" };
    org = orgRow as unknown as OrgDefaults;

    let q = db
      .from("users")
      .select("id, name, email, role, manager_id, bookable, deactivated_at")
      .eq("org_id", viewer.org_id)
      .eq("is_test", false);
    // A manager reads only their own reports; an admin reads everybody, including
    // departed users, so a team whose manager has left still has a name over it.
    if (scope.kind === "team") q = q.eq("manager_id", scope.managerId).is("deactivated_at", null);
    const users = (unwrap(await q, "team hours roster") ?? []) as UserRow[];

    if (scope.kind === "team") {
      managers.set(scope.managerId, viewer.name?.trim() || viewer.email);
    } else {
      for (const u of users) managers.set(u.id, u.name?.trim() || u.email);
    }
    agents = users
      .filter((u) => u.role === "agent" && u.deactivated_at === null)
      .map(({ id, name, email, manager_id, bookable }) => ({ id, name, email, manager_id, bookable }));
  } catch (err) {
    log.error("team-hours", { msg: "roster unreadable" }, err);
    return { kind: "unreadable", what: "roster" };
  }

  let schedules: TeamHoursSchedule[];
  try {
    const ids = agents.map((a) => a.id);
    const scheduleRows =
      ids.length === 0
        ? []
        : ((unwrap(
            await (scope.kind === "team"
              ? db
                  .from("availability_schedules")
                  .select("id, user_id, timezone, hours_source, hours_set_at, created_at")
                  .in("user_id", ids)
              : db
                  .from("availability_schedules")
                  .select("id, user_id, timezone, hours_source, hours_set_at, created_at")),
            "team hours schedules",
          ) ?? []) as ScheduleRow[]);

    const scheduleIds = scheduleRows.map((s) => s.id);
    // Paged: one rule per agent per working day is about 700 rows for the whole
    // roster today and 1,400 at the design target, past the 1,000 row cap, and a
    // truncated read here draws the last agents as having no hours.
    const rules =
      scheduleIds.length === 0
        ? []
        : await selectAllPages<RuleRow>("team hours rules", (from, to) =>
            scope.kind === "team"
              ? db
                  .from("availability_rules")
                  .select("schedule_id, weekday, start_minute, end_minute")
                  .in("schedule_id", scheduleIds)
                  .order("id")
                  .range(from, to)
              : db
                  .from("availability_rules")
                  .select("schedule_id, weekday, start_minute, end_minute")
                  .order("id")
                  .range(from, to),
          );

    const rulesBySchedule = new Map<string, TeamHoursSchedule["rules"]>();
    for (const r of rules) {
      const list = rulesBySchedule.get(r.schedule_id) ?? [];
      list.push({ weekday: r.weekday, start_minute: r.start_minute, end_minute: r.end_minute });
      rulesBySchedule.set(r.schedule_id, list);
    }
    schedules = scheduleRows.map((s) => ({
      user_id: s.user_id,
      timezone: s.timezone,
      hours_source: s.hours_source,
      hours_set_at: s.hours_set_at,
      created_at: s.created_at,
      rules: rulesBySchedule.get(s.id) ?? [],
    }));
  } catch (err) {
    log.error("team-hours", { msg: "hours unreadable" }, err);
    return { kind: "unreadable", what: "hours" };
  }

  return { kind: "ok", groups: buildTeamHours({ scope, agents, schedules, managers, org }) };
}
