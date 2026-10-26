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
import { inIdChunks } from "@/lib/db/id-batch";
import type { OrgDefaults } from "@/lib/schedule-core";
import { groupRulesBySchedule, type HoursSource } from "@/lib/monitor/unset-hours";
import { onRoster } from "@/lib/admin/roster-filter";
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
  is_test: boolean;
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
      .select("id, name, email, role, manager_id, bookable, deactivated_at, is_test")
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
      // The roster's own predicate (#1802), so this page and the roster count one
      // population however the rows arrived.
      .filter((u) => u.role === "agent" && onRoster(u))
      .map(({ id, name, email, manager_id, bookable }) => ({ id, name, email, manager_id, bookable }));
  } catch (err) {
    log.error("team-hours", { msg: "roster unreadable" }, err);
    return { kind: "unreadable", what: "roster" };
  }

  let schedules: TeamHoursSchedule[];
  try {
    const ids = agents.map((a) => a.id);
    // Both hours reads are narrowed to the roster just read, in EVERY scope, so
    // the admin view never pulls test agents' or another org's schedules. The id
    // lists are split by URL bytes (`inIdChunks`), because the roster can pass the
    // ~266 uuids one `in` filter carries, and a failed batch throws rather than
    // returning a short list that reads as agents with no hours.
    const scheduleRows = (
      await inIdChunks("team hours schedules", ids, async (chunk) =>
        (unwrap(
          await db
            .from("availability_schedules")
            .select("id, user_id, timezone, hours_source, hours_set_at, created_at")
            .in("user_id", chunk),
          "team hours schedules",
        ) ?? []) as ScheduleRow[],
      )
    ).flat();

    const scheduleIds = scheduleRows.map((s) => s.id);
    // Paged as well: one rule per agent per working day is about 700 rows for the
    // whole roster today and 1,400 at the design target, past the 1,000 row cap,
    // and a truncated read here draws the last agents as having no hours.
    const rules = (
      await inIdChunks("team hours rules", scheduleIds, (chunk) =>
        selectAllPages<RuleRow>("team hours rules", "id", () =>
          db
            .from("availability_rules")
            .select("id, schedule_id, weekday, start_minute, end_minute")
            .in("schedule_id", chunk),
        ),
      )
    ).flat();

    // The same grouping the unset hours detector and the roster use (#1802).
    const rulesBySchedule = groupRulesBySchedule(rules);
    schedules = scheduleRows.map((s) => ({
      user_id: s.user_id,
      timezone: s.timezone,
      hours_source: s.hours_source,
      hours_set_at: s.hours_set_at,
      created_at: s.created_at,
      rules: (rulesBySchedule.get(s.id) ?? []).map(({ weekday, start_minute, end_minute }) => ({
        weekday,
        start_minute,
        end_minute,
      })),
    }));
  } catch (err) {
    log.error("team-hours", { msg: "hours unreadable" }, err);
    return { kind: "unreadable", what: "hours" };
  }

  return { kind: "ok", groups: buildTeamHours({ scope, agents, schedules, managers, org }) };
}
