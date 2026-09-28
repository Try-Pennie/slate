/**
 * A team's working hours, read in one pass (#1757).
 *
 * On 2026-09-02 the hours and timezone of 97 agents were copied into Slate from
 * cal.com, and the only way to check any of them was to open one agent at a time,
 * so nobody did. This is the view that makes checking practical: every agent's zone
 * and week in one table, grouped by manager.
 *
 * PURE, so `scripts/test-team-hours.ts` drives the scope, the order and every state
 * without a database. The loader beside it does the reads.
 *
 * Three decisions live here rather than in the page.
 *
 * SCOPE. A manager or team lead sees the people whose manager of record they are;
 * an admin sees everybody. The loader narrows its query the same way, and this
 * builder refuses an out of scope row on its own as well, so a loader that forgot
 * its filter still cannot show a manager another team.
 *
 * NO HOURS IS NOT A WEEK. `workingHoursDays` ticks Monday to Friday when nothing
 * is stored, which is the right start for somebody's editor and the wrong answer
 * for a report of what is stored. So an agent with no rules is its own state here,
 * and a week is only built from rules that exist.
 *
 * ORDER. Teams by manager name, then the people whose manager cannot be named, then
 * the people with no manager of record. Inside a team, attention first: no hours
 * (offered nothing at all), then the untouched company default (right only by
 * coincidence, #1753), then everybody else by name. A manager's question is "is
 * anything wrong with my team", and those two states are the answer when it is yes.
 */
import { atLeast } from "@/lib/auth/roles";
import type { Role } from "@/lib/db/types";
import { formatTimeOfDay } from "@/lib/date/parse";
import { zoneLabel } from "@/lib/booking/timezones";
import { workingHoursDays } from "@/lib/schedule-week";
import type { OrgDefaults } from "@/lib/schedule-core";
import { isUnsetHours, type HoursSource, type UnsetHoursSchedule } from "@/lib/monitor/unset-hours";

export type TeamHoursScope = { kind: "all" } | { kind: "team"; managerId: string };

/** Who may see which teams. Null for somebody with no team view at all. */
export function teamHoursScope(viewer: { id: string; role: Role }): TeamHoursScope | null {
  if (atLeast(viewer.role, "admin")) return { kind: "all" };
  if (atLeast(viewer.role, "manager")) return { kind: "team", managerId: viewer.id };
  return null;
}

export interface TeamHoursAgent {
  id: string;
  name: string | null;
  email: string;
  manager_id: string | null;
  bookable: boolean;
}

/** The same shape the unset hours detector reads, so the two judge one record. */
export type TeamHoursSchedule = UnsetHoursSchedule;

/** Who last wrote a week, with the unstamped rows resolved as far as evidence goes. */
export type SetBy = HoursSource | "not-recorded";
export const SET_BY_KINDS: readonly SetBy[] = ["agent", "admin", "calcom-import", "seed", "not-recorded"];

export function setByLabel(kind: SetBy): string {
  switch (kind) {
    case "agent":
      return "The agent";
    case "admin":
      return "A manager or admin";
    case "calcom-import":
      return "Copied from cal.com";
    case "seed":
      return "Company default, never changed";
    case "not-recorded":
      return "Not recorded";
  }
}

/** One day's windows as the page prints them. Empty is a day off. */
export type DayWindows = { start: string; end: string }[];

export type TeamHoursCell =
  | { kind: "none" }
  | { kind: "set"; zone: string; zoneLabel: string; days: DayWindows[]; setBy: SetBy };

export interface TeamHoursRow {
  id: string;
  name: string;
  email: string;
  bookable: boolean;
  hours: TeamHoursCell;
}

export interface TeamHoursGroup {
  /** null = the people with no manager of record. */
  managerId: string | null;
  /** null when there is no manager, or the id names nobody the roster read holds. */
  managerName: string | null;
  rows: TeamHoursRow[];
}

export interface TeamHoursInput {
  scope: TeamHoursScope;
  agents: TeamHoursAgent[];
  schedules: TeamHoursSchedule[];
  /** Manager id to display name, for every manager the roster read holds. */
  managers: Map<string, string>;
  org: OrgDefaults;
}

function cellFor(s: TeamHoursSchedule | undefined, org: OrgDefaults): TeamHoursCell {
  if (!s || s.rules.length === 0) return { kind: "none" };
  const setBy: SetBy =
    s.hours_source ?? (isUnsetHours(s, org) ? "seed" : "not-recorded");
  const days = workingHoursDays(s.rules).map((d) =>
    d.on
      ? d.windows.map((w) => ({
          // minutesToTime always yields a readable HH:MM, so a null here would be a
          // stored minute outside the day; it prints as the raw value rather than a
          // plausible time nobody chose.
          start: formatTimeOfDay(w.start) ?? w.start,
          end: formatTimeOfDay(w.end) ?? w.end,
        }))
      : [],
  );
  return { kind: "set", zone: s.timezone, zoneLabel: zoneLabel(s.timezone), days, setBy };
}

/** Lower sorts first: the state most in need of a look. */
function attention(c: TeamHoursCell): number {
  if (c.kind === "none") return 0;
  return c.setBy === "seed" ? 1 : 2;
}

const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

export function buildTeamHours(input: TeamHoursInput): TeamHoursGroup[] {
  const scheduleByUser = new Map(input.schedules.map((s) => [s.user_id, s]));
  const inScope = input.agents.filter((a) =>
    input.scope.kind === "all" ? true : a.manager_id === input.scope.managerId,
  );

  const groups = new Map<string | null, TeamHoursGroup>();
  for (const a of inScope) {
    const key = a.manager_id;
    let g = groups.get(key);
    if (!g) {
      g = { managerId: key, managerName: key ? (input.managers.get(key) ?? null) : null, rows: [] };
      groups.set(key, g);
    }
    g.rows.push({
      id: a.id,
      name: a.name?.trim() || a.email,
      email: a.email,
      bookable: a.bookable,
      hours: cellFor(scheduleByUser.get(a.id), input.org),
    });
  }

  for (const g of groups.values()) {
    g.rows.sort((x, y) => attention(x.hours) - attention(y.hours) || byName(x.name, y.name));
  }

  // Named managers by name, then a manager id nobody can name, then no manager.
  const rank = (g: TeamHoursGroup) => (g.managerName !== null ? 0 : g.managerId !== null ? 1 : 2);
  return [...groups.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      byName(a.managerName ?? a.managerId ?? "", b.managerName ?? b.managerId ?? ""),
  );
}
