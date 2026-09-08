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
// shape was set by somebody. This file pins that judgement.
import { agentsOnUnsetHours, runUnsetHoursCheck, formatUnsetHoursAlert, type UnsetHoursInput } from "@/lib/monitor/unset-hours";
import { assert, eq, finish } from "./lib/harness.ts";

const org = { default_timezone: "America/New_York", default_start_minute: 480, default_end_minute: 1020, default_weekdays: [1, 2, 3, 4, 5] };
const seedWeek = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 }));
const realWeek = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 600, end_minute: 1140 }));

function input(over: Partial<UnsetHoursInput> = {}): UnsetHoursInput {
  return {
    org,
    agents: [{ id: "u1", email: "a@x", name: "A" }],
    schedules: [{ user_id: "u1", timezone: "America/New_York", hours_source: null, rules: seedWeek }],
    ...over,
  };
}

// --- the stamp decides when it is there ---------------------------------------------
{
  eq(agentsOnUnsetHours(input({ schedules: [{ user_id: "u1", timezone: "America/New_York", hours_source: "seed", rules: seedWeek }] })).length, 1, "a week the seeding wrote is unset hours");
  for (const src of ["agent", "admin", "calcom-import"] as const) {
    eq(agentsOnUnsetHours(input({ schedules: [{ user_id: "u1", timezone: "America/New_York", hours_source: src, rules: seedWeek }] })).length, 0, `a week set by ${src} is set, even when it happens to equal the seed`);
  }
}

// --- before the stamp existed, the shape decides -----------------------------------------
{
  eq(agentsOnUnsetHours(input()).length, 1, "no source and exactly the seed's week: never touched");
  eq(agentsOnUnsetHours(input({ schedules: [{ user_id: "u1", timezone: "America/New_York", hours_source: null, rules: realWeek }] })).length, 0, "no source and a different week: somebody set it before the stamp");
  // The zone is part of the shape: the same minutes in a different zone is a
  // deliberate change (the 2026-09-02 import moved 74 agents' zones with the hours).
  eq(agentsOnUnsetHours(input({ schedules: [{ user_id: "u1", timezone: "America/Phoenix", hours_source: null, rules: seedWeek }] })).length, 0, "no source, seed minutes, another zone: set");
  // Order and duplicates must not fool it either way.
  const shuffled = [...seedWeek].reverse();
  eq(agentsOnUnsetHours(input({ schedules: [{ user_id: "u1", timezone: "America/New_York", hours_source: null, rules: shuffled }] })).length, 1, "the seed's week in another order is still the seed");
  eq(agentsOnUnsetHours(input({ schedules: [{ user_id: "u1", timezone: "America/New_York", hours_source: null, rules: seedWeek.slice(0, 4) }] })).length, 0, "the seed minus a day is a different week");
}

// --- who is in scope ----------------------------------------------------------------------
{
  // No schedule at all is the OTHER check's finding (agents_without_schedule); this
  // one must not double report it.
  eq(agentsOnUnsetHours(input({ schedules: [] })).length, 0, "an agent with no schedule row is not reported here");
  eq(agentsOnUnsetHours(input({ schedules: [{ user_id: "u1", timezone: "America/New_York", hours_source: null, rules: [] }] })).length, 0, "nor one with a row and no rules");
  const out = agentsOnUnsetHours(input({ agents: [{ id: "u1", email: "a@x", name: "A" }, { id: "u2", email: "b@x", name: null }], schedules: [
    { user_id: "u1", timezone: "America/New_York", hours_source: "seed", rules: seedWeek },
    { user_id: "u2", timezone: "America/New_York", hours_source: "admin", rules: seedWeek },
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
  });

  const r1 = await runUnsetHoursCheck(deps(async () => input()));
  eq(r1.status, "paged", "an unset week pages");
  eq(paged.length, 1, "once");

  paged.length = 0; resolved.length = 0;
  const r2 = await runUnsetHoursCheck(deps(async () => input({ schedules: [{ user_id: "u1", timezone: "America/New_York", hours_source: "agent", rules: seedWeek }] })));
  eq(r2.status, "clear", "a sweep that found nobody clears");
  eq(resolved.length, 1, "and posts the all clear through the resolver");

  paged.length = 0; resolved.length = 0;
  const r3 = await runUnsetHoursCheck(deps(async () => { throw new Error("boom"); }));
  eq(r3.status, "unreadable", "a failed read is reported as unmeasured");
  eq(paged.length, 0, "it pages nobody");
  eq(resolved.length, 0, "and sends no all-clear, because it measured nothing (#1152)");
}

// --- copy --------------------------------------------------------------------------------
{
  const text = formatUnsetHoursAlert([{ id: "u1", email: "cfrank@x", name: "C Frank" }]);
  assert(/1 bookable agent is/.test(text), "singular reads as singular");
  assert(/cfrank@x/.test(text), "names who");
  assert(/import:calcom-schedules/.test(text), "and says where the fix lives");
  assert(!/^Slate/.test(text), "does not open with the word Slate");
  assert(!/[\u2014\u2013]/.test(text), "no dashes as punctuation");
}

finish();
