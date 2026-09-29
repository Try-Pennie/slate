// A bookable agent on hours nobody set (#1753). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-unset-hours.ts
//
// A seeded default is indistinguishable from a deliberate choice: every one of 117
// agents carried the same Monday to Friday 08:00 to 17:00 Eastern for months, and
// 81 of 100 turned out to keep different hours (#1738). The stamp on
// `availability_schedules` (`hours_source`, `hours_set_at`) makes "nobody has set
// this" a recorded fact going forward. The rows written BEFORE the stamp existed
// carry no source (L223), so for those the store's own evidence decides: a week
// still shaped exactly like the org default was never touched, and any other
// shape was set by somebody. This file pins that judgement, and the two day
// patience on top of it: every new hire is seeded with the default week, so an
// alert with no grace names each of them the day they go bookable and repeats
// daily until somebody edits their hours, which is how an alert stops being read
// (L36). The grace is on the ALERT only; `agentsOnUnsetHours` still reports
// everybody unset, because `verify:parallel-run-readiness` asks a different
// question and wants them all.
import {
  agentsOnUnsetHours,
  agentsPastUnsetHoursGrace,
  runUnsetHoursCheck,
  formatUnsetHoursAlert,
  formatUnsetHoursRecovery,
  UNSET_HOURS_GRACE_MS,
  type UnsetHoursInput,
  type UnsetHoursSchedule,
} from "@/lib/monitor/unset-hours";
import { assert, eq, finish } from "./lib/harness.ts";

const org = { default_timezone: "America/New_York", default_start_minute: 480, default_end_minute: 1020, default_weekdays: [1, 2, 3, 4, 5] };
const seedWeek = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 }));
const realWeek = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 600, end_minute: 1140 }));

// A fixed clock: nothing here may read the real one (L290).
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const DAY = 24 * 60 * 60_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

/** A schedule row, stamped as written long enough ago to be past the grace. */
function sched(over: Partial<UnsetHoursSchedule> = {}): UnsetHoursSchedule {
  return {
    user_id: "u1",
    timezone: "America/New_York",
    hours_source: null,
    hours_set_at: null,
    created_at: daysAgo(30),
    rules: seedWeek,
    ...over,
  };
}

function input(over: Partial<UnsetHoursInput> = {}): UnsetHoursInput {
  return {
    org,
    agents: [{ id: "u1", email: "a@x", name: "A" }],
    schedules: [sched()],
    ...over,
  };
}

// --- the stamp decides when it is there ---------------------------------------------
{
  eq(agentsOnUnsetHours(input({ schedules: [sched({ hours_source: "seed", hours_set_at: daysAgo(30) })] })).length, 1, "a week the seeding wrote is unset hours");
  for (const src of ["agent", "admin", "calcom-import"] as const) {
    eq(agentsOnUnsetHours(input({ schedules: [sched({ hours_source: src, hours_set_at: daysAgo(30) })] })).length, 0, `a week set by ${src} is set, even when it happens to equal the seed`);
  }
}

// --- before the stamp existed, the shape decides -----------------------------------------
{
  eq(agentsOnUnsetHours(input()).length, 1, "no source and exactly the seed's week: never touched");
  eq(agentsOnUnsetHours(input({ schedules: [sched({ rules: realWeek })] })).length, 0, "no source and a different week: somebody set it before the stamp");
  // The zone is part of the shape: the same minutes in a different zone is a
  // deliberate change (the 2026-09-02 import moved 74 agents' zones with the hours).
  eq(agentsOnUnsetHours(input({ schedules: [sched({ timezone: "America/Phoenix" })] })).length, 0, "no source, seed minutes, another zone: set");
  // Order and duplicates must not fool it either way.
  const shuffled = [...seedWeek].reverse();
  eq(agentsOnUnsetHours(input({ schedules: [sched({ rules: shuffled })] })).length, 1, "the seed's week in another order is still the seed");
  eq(agentsOnUnsetHours(input({ schedules: [sched({ rules: seedWeek.slice(0, 4) })] })).length, 0, "the seed minus a day is a different week");
}

// --- who is in scope ----------------------------------------------------------------------
{
  // No schedule at all is the OTHER check's finding (agents_without_schedule); this
  // one must not double report it.
  eq(agentsOnUnsetHours(input({ schedules: [] })).length, 0, "an agent with no schedule row is not reported here");
  eq(agentsOnUnsetHours(input({ schedules: [sched({ rules: [] })] })).length, 0, "nor one with a row and no rules");
  const out = agentsOnUnsetHours(input({ agents: [{ id: "u1", email: "a@x", name: "A" }, { id: "u2", email: "b@x", name: null }], schedules: [
    sched({ hours_source: "seed", hours_set_at: daysAgo(30) }),
    sched({ user_id: "u2", hours_source: "admin", hours_set_at: daysAgo(30) }),
  ] }));
  eq(out.map((a) => a.email).join(","), "a@x", "only the unset one is named");
}

// --- the org default can change -------------------------------------------------------------
{
  const moved = { ...org, default_start_minute: 540, default_end_minute: 1080 };
  eq(agentsOnUnsetHours(input({ org: moved })).length, 0, "a pre stamp week shaped like the OLD seed is not the current seed, so it reads as set");
  assert(true, "which is the honest reading: the evidence rule can only see the default as it stands now");
}

// --- the lane step: both directions hang off a measured sweep -----------------------
{
  const paged: string[] = [];
  const resolved: string[] = [];
  const deps = (load: () => Promise<UnsetHoursInput>) => ({
    load,
    notify: async (key: string) => { paged.push(key); },
    resolve: async (key: string) => { resolved.push(key); return true; },
    cooldownMs: 1,
    nowMs: NOW,
  });

  const r1 = await runUnsetHoursCheck(deps(async () => input()));
  eq(r1.status, "paged", "an unset week pages");
  eq(paged.length, 1, "once");

  paged.length = 0; resolved.length = 0;
  const r2 = await runUnsetHoursCheck(deps(async () => input({ schedules: [sched({ hours_source: "agent", hours_set_at: daysAgo(30) })] })));
  eq(r2.status, "clear", "a sweep that found nobody clears");
  eq(resolved.length, 1, "and posts the all clear through the resolver");

  paged.length = 0; resolved.length = 0;
  const r3 = await runUnsetHoursCheck(deps(async () => { throw new Error("boom"); }));
  eq(r3.status, "unreadable", "a failed read is reported as unmeasured");
  eq(paged.length, 0, "it pages nobody");
  eq(resolved.length, 0, "and sends no all-clear, because it measured nothing (#1152)");
}

// --- the grace: a new hire is not named on their first day ----------------------------
{
  // The predicate itself is unchanged: it answers "is this week unset", which is
  // what the readiness command asks. The patience lives above it.
  eq(agentsOnUnsetHours(input({ schedules: [sched({ created_at: daysAgo(0) })] })).length, 1, "a week seeded this morning is still unset hours");

  const pastGrace = (createdDaysAgo: number) =>
    agentsPastUnsetHoursGrace(agentsOnUnsetHours(input({ schedules: [sched({ created_at: daysAgo(createdDaysAgo) })] })), NOW).length;
  eq(pastGrace(0), 0, "seeded this morning: inside the grace, say nothing");
  eq(pastGrace(1), 0, "one day: still inside");
  eq(pastGrace(3), 1, "three days: nobody set them, and onboarding has had its chance");
  eq(UNSET_HOURS_GRACE_MS, 2 * DAY, "the grace is two days");

  // The boundary, both sides of it, so neither an off by one nor a flipped
  // comparison can pass (L1).
  const at = (ms: number) => agentsPastUnsetHoursGrace(agentsOnUnsetHours(input({ schedules: [sched({ created_at: new Date(ms).toISOString() })] })), NOW).length;
  eq(at(NOW - UNSET_HOURS_GRACE_MS + 60_000), 0, "a minute short of the grace is silent");
  eq(at(NOW - UNSET_HOURS_GRACE_MS - 60_000), 1, "a minute past it is named");

  // The stamp beats the row's age: the seeding RPC records WHEN it wrote, and a
  // row created long ago can have been re seeded this morning.
  eq(agentsPastUnsetHoursGrace(agentsOnUnsetHours(input({ schedules: [sched({ hours_source: "seed", hours_set_at: daysAgo(0), created_at: daysAgo(90) })] })), NOW).length, 0, "hours_set_at is the anchor when it is there");
  eq(agentsPastUnsetHoursGrace(agentsOnUnsetHours(input({ schedules: [sched({ hours_source: "seed", hours_set_at: daysAgo(9), created_at: daysAgo(90) })] })), NOW).length, 1, "and it ages like any other stamp");

  // An unreadable stamp must FAIL LOUD. Suppressing on a date nothing can read
  // would silently disable the alert, and a NaN comparison lands on the quiet
  // branch by default (L: parseStampMs).
  for (const bad of ["", "not a date", "0000-00-00"]) {
    eq(agentsPastUnsetHoursGrace(agentsOnUnsetHours(input({ schedules: [sched({ created_at: bad })] })), NOW).length, 1, `an unreadable created_at (${JSON.stringify(bad)}) is named, never silently spared`);
  }
  eq(agentsPastUnsetHoursGrace(agentsOnUnsetHours(input({ schedules: [sched({ hours_source: "seed", hours_set_at: "nonsense", created_at: daysAgo(0) })] })), NOW).length, 1, "an unreadable hours_set_at too, even with a fresh created_at beside it");
}

// --- the lane step applies the grace --------------------------------------------------
{
  const paged: string[] = [];
  const resolved: string[] = [];
  const deps = (over: Partial<UnsetHoursInput>) => ({
    load: async () => input(over),
    notify: async (key: string) => { paged.push(key); },
    resolve: async (key: string) => { resolved.push(key); return true; },
    cooldownMs: 1,
    nowMs: NOW,
  });

  const fresh = await runUnsetHoursCheck(deps({ schedules: [sched({ created_at: daysAgo(1) })] }));
  eq(fresh.status, "clear", "a roster whose only unset agent is inside the grace clears");
  eq(paged.length, 0, "and pages nobody");
  eq(resolved.length, 1, "the all clear is posted, because the sweep really ran");

  paged.length = 0; resolved.length = 0;
  const stuck = await runUnsetHoursCheck(deps({ schedules: [sched({ created_at: daysAgo(7) })] }));
  eq(stuck.status, "paged", "one past the grace still pages");
  eq(stuck.status === "paged" ? stuck.agents.length : -1, 1, "naming them");
}

// --- copy --------------------------------------------------------------------------------
{
  const text = formatUnsetHoursAlert([{ id: "u1", email: "cfrank@x", name: "C Frank", unsetSinceMs: NOW - 3 * DAY }], NOW);
  assert(/1 bookable agent has/.test(text), "singular reads as singular");
  assert(/cfrank@x/.test(text), "names who");
  assert(/import:calcom-schedules/.test(text), "and says where the fix lives");
  assert(!/^Slate/.test(text), "does not open with the word Slate");
  assert(!/[\u2014\u2013]/.test(text), "no dashes as punctuation");
}

// --- copy: it may claim only what the check measured -----------------------------------
{
  const findings = agentsOnUnsetHours(input({
    agents: [{ id: "u1", email: "cfrank@x", name: "C Frank" }, { id: "u2", email: "jsaminu@x", name: null }],
    schedules: [sched({ created_at: daysAgo(7) }), sched({ user_id: "u2", created_at: daysAgo(31) })],
  }));
  const text = formatUnsetHoursAlert(findings, NOW);
  assert(/2 bookable agents have/.test(text), "plural reads as plural");
  assert(/more than 2 days/.test(text), "the alert states the patience it now has, since that is what it measured (L440)");
  assert(/cfrank@x\), 7 days/.test(text), "and how long each has actually sat there");
  assert(/jsaminu@x, 31 days/.test(text), "for every agent named");
  assert(!/[\u2014\u2013]/.test(text), "no dashes as punctuation");

  const unreadable = formatUnsetHoursAlert(agentsOnUnsetHours(input({ schedules: [sched({ created_at: "nonsense" })] })), NOW);
  assert(/unreadable/.test(unreadable), "an agent whose stamp cannot be read says so, rather than rendering NaN days");
  assert(!/NaN|undefined|Invalid/.test(unreadable), "and never leaks a broken number into Slack");

  const recovery = formatUnsetHoursRecovery();
  assert(/2 days/.test(recovery), "the all clear names the same window, so it cannot be read as 'everybody's hours are set'");
  assert(!/[\u2014\u2013]/.test(recovery), "no dashes there either");
}

// --- #2875: once cal.com is retired, the page must not name a fix that cannot work ---
{
  const who = [{ id: "u1", email: "cfrank@x", name: "C Frank", unsetSinceMs: NOW - 3 * DAY }];
  const retired = formatUnsetHoursAlert(who, NOW, { calcomRetired: true });
  assert(!/calcom|cal\.com/i.test(retired), "retired: no cal.com import is offered, since there is nothing to import from");
  assert(/admin > agent hours/.test(retired), "retired: it still says where the fix lives");
  assert(/set their own hours/i.test(retired), "retired: and that the agent can set them");
  assert(/cfrank@x/.test(retired), "retired: still names who");
  assert(!/[\u2014\u2013]/.test(retired), "retired: no dashes as punctuation");
  const live = formatUnsetHoursAlert(who, NOW, { calcomRetired: false });
  assert(/import:calcom-schedules/.test(live), "live: the cal.com import is offered, as today");
  const unknown = formatUnsetHoursAlert(who, NOW, { calcomRetired: null });
  eq(unknown, live, "unreadable setting: today's wording, since the import may well still work");

  const pages: string[] = [];
  const deps = (retiredAnswer: boolean | null | "throw") => ({
    load: async () => input(),
    notify: async (_key: string, _ms: number, text: string) => { pages.push(text); },
    resolve: async () => true,
    cooldownMs: 1,
    nowMs: NOW,
    calcomRetired: async () => {
      if (retiredAnswer === "throw") throw new Error("monitor_alert_config read failed");
      return retiredAnswer;
    },
  });
  await runUnsetHoursCheck(deps(true));
  assert(pages.length === 1 && !/calcom/i.test(pages[0]), "the lane step pages the retired wording when cal.com is retired");
  pages.length = 0;
  await runUnsetHoursCheck(deps("throw"));
  assert(pages.length === 1 && /import:calcom-schedules/.test(pages[0]), "a throwing read pages today's wording, and still pages");
}

finish();
