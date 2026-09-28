// The team hours view (#1757). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-team-hours.ts
//
// WHAT THIS EXISTS TO STOP. On 2026-09-02 the hours of 97 agents were copied into
// Slate from cal.com and nobody who knows the shifts looked at any of them, because
// the only way to look was one agent at a time. This view lets a manager read their
// team in one pass, and it is only worth having if three things hold:
//
//   1. A manager sees their own team and nobody else's, decided on the server.
//   2. An agent with no hours reads differently from an agent with hours, and never
//      as a week somebody could mistake for real (the hours form ticks Monday to
//      Friday when nothing is stored, which is right for a new agent's editor and
//      wrong for a report about what is stored).
//   3. The order puts the agents needing attention first inside each team.
import {
  buildTeamHours,
  teamHoursScope,
  setByLabel,
  SET_BY_KINDS,
  type TeamHoursAgent,
  type TeamHoursSchedule,
} from "@/lib/admin/team-hours";
import { hoursOriginNote } from "@/lib/admin/working-hours-copy";
import type { OrgDefaults } from "@/lib/schedule-core";
import { assert, eq, finish } from "./lib/harness.ts";

const ORG: OrgDefaults = {
  default_timezone: "America/New_York",
  default_start_minute: 480,
  default_end_minute: 1020,
  default_weekdays: [1, 2, 3, 4, 5],
};

const agent = (id: string, name: string, manager_id: string | null): TeamHoursAgent => ({
  id,
  name,
  email: `${id}@example.com`,
  manager_id,
  bookable: true,
});

const weekdays = (start: number, end: number, days = [1, 2, 3, 4, 5]) =>
  days.map((weekday) => ({ weekday, start_minute: start, end_minute: end }));

const schedule = (
  user_id: string,
  rules: TeamHoursSchedule["rules"],
  over: Partial<TeamHoursSchedule> = {},
): TeamHoursSchedule => ({
  user_id,
  timezone: "America/Chicago",
  hours_source: "agent",
  hours_set_at: "2026-09-10T12:00:00Z",
  created_at: "2026-08-01T12:00:00Z",
  rules,
  ...over,
});

const managers = new Map([
  ["m-zed", "Zed Manager"],
  ["m-amy", "Amy Manager"],
]);

// --- scope ---------------------------------------------------------------------
eq(teamHoursScope({ id: "m-amy", role: "manager" }), { kind: "team", managerId: "m-amy" }, "a manager is scoped to their own team");
eq(teamHoursScope({ id: "t1", role: "team_lead" }), { kind: "team", managerId: "t1" }, "a team lead is scoped to their own team too");
eq(teamHoursScope({ id: "a1", role: "admin" }), { kind: "all" }, "an admin sees every team");
eq(teamHoursScope({ id: "s1", role: "super_admin" }), { kind: "all" }, "a super admin sees every team");
eq(teamHoursScope({ id: "x", role: "agent" }), null, "an agent has no team view at all");

{
  // The loader narrows the query too, but the builder refuses an out of scope row
  // on its own, so a loader that forgot its filter cannot show a manager another
  // team (L18: enforce it where the data is assembled, not only at one layer).
  const groups = buildTeamHours({
    scope: { kind: "team", managerId: "m-amy" },
    agents: [agent("a", "Ann", "m-amy"), agent("b", "Bob", "m-zed"), agent("c", "Cat", null)],
    schedules: [schedule("a", weekdays(540, 1020)), schedule("b", weekdays(540, 1020))],
    managers,
    org: ORG,
  });
  eq(groups.length, 1, "a manager gets exactly one group");
  eq(groups[0]!.rows.map((r) => r.id), ["a"], "holding only their own reports, never another team or the unmanaged");
}

// --- rendering the week ----------------------------------------------------------
{
  const [group] = buildTeamHours({
    scope: { kind: "all" },
    agents: [agent("a", "Ann", "m-amy")],
    schedules: [
      schedule("a", [
        ...weekdays(540, 1020, [1, 2, 3]),
        { weekday: 4, start_minute: 480, end_minute: 720 },
        { weekday: 4, start_minute: 780, end_minute: 1020 },
      ]),
    ],
    managers,
    org: ORG,
  });
  const row = group!.rows[0]!;
  assert(row.hours.kind === "set", "an agent with rules has a week");
  if (row.hours.kind === "set") {
    eq(row.hours.zone, "America/Chicago", "the zone is the agent's own");
    eq(row.hours.zoneLabel, "Central time (Chicago)", "and reads as the picker names it");
    eq(row.hours.days.length, 7, "seven days, Monday first");
    eq(row.hours.days[0], [{ start: "9:00am", end: "5:00pm" }], "Monday reads in the house time spelling");
    eq(row.hours.days[3], [{ start: "8:00am", end: "12:00pm" }, { start: "1:00pm", end: "5:00pm" }], "a split day keeps both windows, in order");
    eq(row.hours.days[4], [], "a day with no rule is off");
    eq(row.hours.days[6], [], "and so is Sunday");
  }
}

// --- no hours is its own state, never a week -------------------------------------
{
  const [group] = buildTeamHours({
    scope: { kind: "all" },
    agents: [agent("row-no-rules", "Ann", "m-amy"), agent("no-row", "Bea", "m-amy")],
    schedules: [schedule("row-no-rules", [])],
    managers,
    org: ORG,
  });
  for (const r of group!.rows) {
    eq(r.hours.kind, "none", `${r.name} with no working hours reads as none, not as the form's Monday to Friday fallback`);
  }
}

// --- who set it ------------------------------------------------------------------
{
  const [group] = buildTeamHours({
    scope: { kind: "all" },
    agents: ["agent", "admin", "import", "seed", "old-seed", "old-other"].map((id) => agent(id, id, "m-amy")),
    schedules: [
      schedule("agent", weekdays(540, 1020), { hours_source: "agent" }),
      schedule("admin", weekdays(540, 1020), { hours_source: "admin" }),
      schedule("import", weekdays(540, 1020), { hours_source: "calcom-import" }),
      schedule("seed", weekdays(480, 1020), { hours_source: "seed", timezone: "America/New_York" }),
      // Written before the stamp existed: the seed's exact shape, zone included, is
      // the store's own evidence nobody touched it (#1753's rule, reused).
      schedule("old-seed", weekdays(480, 1020), { hours_source: null, timezone: "America/New_York" }),
      schedule("old-other", weekdays(540, 1020), { hours_source: null }),
    ],
    managers,
    org: ORG,
  });
  const by = new Map(group!.rows.map((r) => [r.id, r.hours.kind === "set" ? r.hours.setBy : null]));
  eq(by.get("agent"), "agent", "the agent's own save");
  eq(by.get("admin"), "admin", "a manager or admin's save");
  eq(by.get("import"), "calcom-import", "the cal.com import");
  eq(by.get("seed"), "seed", "the stamped seed");
  eq(by.get("old-seed"), "seed", "an unstamped week shaped exactly like the default is the default");
  eq(by.get("old-other"), "not-recorded", "any other unstamped week is not recorded, never guessed");

  // Every kind has its own label and no two share one (L11).
  const labels = SET_BY_KINDS.map(setByLabel);
  eq(new Set(labels).size, SET_BY_KINDS.length, "each way a week was set has its own words");
  for (const l of labels) assert(l.length > 0 && !/undefined/.test(l), `label reads as words: ${l}`);
}

// --- order -------------------------------------------------------------------------
{
  const groups = buildTeamHours({
    scope: { kind: "all" },
    agents: [
      agent("z", "Zoe", "m-amy"),
      agent("d", "Dee", "m-amy"),
      agent("n", "Nia", "m-amy"),
      agent("s", "Sam", "m-amy"),
      agent("u", "Uma", null),
      agent("y", "Yan", "m-zed"),
      // A manager id nobody can name (offboarded, or outside the roster read) still
      // groups, under the id's own heading rather than being dropped.
      agent("g", "Gus", "m-gone"),
    ],
    schedules: [
      schedule("z", weekdays(540, 1020)),
      schedule("d", weekdays(540, 1020)),
      schedule("s", weekdays(480, 1020), { hours_source: "seed", timezone: "America/New_York" }),
      schedule("u", weekdays(540, 1020)),
      schedule("y", weekdays(540, 1020)),
      schedule("g", weekdays(540, 1020)),
    ],
    managers,
    org: ORG,
  });
  eq(
    groups.map((g) => g.managerName),
    ["Amy Manager", "Zed Manager", null, null],
    "teams in manager name order, and the ones with no nameable manager last",
  );
  eq(groups.map((g) => g.managerId), ["m-amy", "m-zed", "m-gone", null], "an unnamed manager comes before no manager at all");
  eq(
    groups[0]!.rows.map((r) => r.id),
    ["n", "s", "d", "z"],
    "inside a team: no hours first, then the untouched default, then everyone else by name",
  );
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  eq(total, 7, "every in scope agent lands in exactly one group");
}

// --- the agent's own line ---------------------------------------------------------
assert(
  /cal\.com/.test(hoursOriginNote("calcom-import") ?? ""),
  "an agent whose week came from cal.com is told so",
);
for (const s of ["agent", "admin", "seed", null] as const) {
  eq(hoursOriginNote(s), null, `and nothing is claimed for ${s ?? "an unrecorded week"}`);
}
{
  const note = hoursOriginNote("calcom-import") ?? "";
  assert(!/[\u2014\u2013]/.test(note), "the note carries no dash");
}

finish();
