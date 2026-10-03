// Import an agent's cal.com week the moment they become bookable (#2627). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-activation-hours.ts
//
// Measured 2026-09-22: nshort@ (Los Angeles, 07:00 to 16:00 local) was flipped
// bookable at 19:58 UTC and sat on the seeded Eastern week until an on demand
// importer run at 20:03. On an ordinary day that gap is up to 24 hours, with the
// booker offering a West Coast agent at 05:00 their time.
//
// What is pinned here, each direction with its own case:
//   - a SEEDED week is replaced with the cal.com week, stamped calcom-import, through
//     the importer's own mapping (`planImportedWeek`);
//   - a week somebody SET is never touched, and cal.com is not even asked;
//   - every way cal.com can fail leaves the seeded week, logs its own reason, and
//     never throws, so activation goes ahead;
//   - the work is bounded by what is left of the activation budget.
import { importHoursOnActivation, type ActivationHoursDeps, type StoredWeek } from "@/lib/bookable/activation-hours";
import { planImportedWeek, type SlateRule } from "@/lib/calcom/schedule-import";
import { HoursChangedDuringImportError } from "@/lib/calcom/import-write";
import type { ScheduleForImportRead } from "@/lib/calcom/client";
import type { OrgDefaults } from "@/lib/schedule-core";
import { assert, eq, finish } from "./lib/harness.ts";

const ORG: OrgDefaults = {
  default_timezone: "America/New_York",
  default_start_minute: 480,
  default_end_minute: 1020,
  default_weekdays: [1, 2, 3, 4, 5],
};
const SEED_RULES: SlateRule[] = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 }));

function week(over: Partial<StoredWeek> = {}): StoredWeek {
  return {
    user_id: "u1",
    timezone: "America/New_York",
    hours_source: "seed",
    hours_set_at: "2026-09-22T19:00:00Z",
    created_at: "2026-09-22T19:00:00Z",
    rules: SEED_RULES,
    ...over,
  };
}

const CAL_LA = {
  id: 9,
  timeZone: "America/Los_Angeles",
  isDefault: true,
  availability: [
    { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], startTime: "07:00", endTime: "16:00" },
  ],
};

interface Rig {
  deps: ActivationHoursDeps;
  writes: { userId: string; timezone: string; rules: SlateRule[] }[];
  /** The source each write was told to expect (#2702). */
  guards: (string | null)[];
  calcomCalls: { email: string; timeoutMs: number }[];
  orgReads: number;
  logs: { level: "info" | "warn"; fields: Record<string, unknown> }[];
}

function rig(opts: {
  stored?: StoredWeek | null | "throw";
  cal?: ScheduleForImportRead;
  org?: OrgDefaults | null | "throw";
  writeThrows?: boolean;
  /** #2702: the write is refused because the stored source changed under it. */
  writeRaced?: boolean;
  remainingMs?: number[];
  /** #2875: the "cal.com retired" read. Default live, the parallel run. */
  retired?: boolean | null | "throw";
} = {}): Rig {
  const r: Rig = { deps: undefined as never, writes: [], guards: [], calcomCalls: [], orgReads: 0, logs: [] };
  const remaining = [...(opts.remainingMs ?? [30_000])];
  r.deps = {
    loadCalcomRetired: async () => {
      if (opts.retired === "throw") throw new Error("monitor_alert_config read failed");
      return opts.retired === undefined ? false : opts.retired;
    },
    loadWeek: async () => {
      if (opts.stored === "throw") throw new Error("availability_schedules read failed");
      return opts.stored === undefined ? week() : opts.stored;
    },
    loadOrgDefaults: async () => {
      r.orgReads++;
      if (opts.org === "throw") throw new Error("organizations read failed");
      return opts.org === undefined ? ORG : opts.org;
    },
    readCalcom: async (email, timeoutMs) => {
      r.calcomCalls.push({ email, timeoutMs });
      return opts.cal ?? { kind: "schedule", schedule: CAL_LA };
    },
    writeWeek: async (userId, w, onlyIfSource) => {
      r.guards.push(onlyIfSource);
      if (opts.writeRaced) throw new HoursChangedDuringImportError("u1", "admin");
      if (opts.writeThrows) throw new Error("replace_user_schedule refused");
      r.writes.push({ userId, timezone: w.timezone, rules: w.rules });
    },
    remainingMs: () => (remaining.length > 1 ? remaining.shift()! : remaining[0]),
    log: {
      info: (_tag, fields) => r.logs.push({ level: "info", fields }),
      warn: (_tag, fields) => r.logs.push({ level: "warn", fields }),
    },
  };
  return r;
}

const AGENT = { id: "u1", email: "nshort@trypennie.com" };

// --- a seeded week is replaced with cal.com's, through the importer's mapping ---
{
  const r = rig();
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind, "imported", "a seeded week is imported on activation");
  eq(r.writes.length, 1, "exactly one write");
  const expected = planImportedWeek(CAL_LA);
  assert(expected.ok, "control: the importer's planner accepts the fixture");
  if (expected.ok) {
    eq(r.writes[0], { userId: "u1", timezone: expected.timezone, rules: expected.rules },
      "what is written is EXACTLY the importer's plan for the same schedule, zone included");
  }
  eq(r.writes[0].timezone, "America/Los_Angeles", "the zone travels with the hours");
  eq(r.calcomCalls[0].email, "nshort@trypennie.com", "cal.com is asked about this agent");
  eq(r.orgReads, 0, "a stamped seed needs no org defaults read");
  const line = r.logs.find((l) => l.level === "info");
  eq(line?.fields.outcome, "imported", "the import is logged as imported");
}

// --- a pre stamp row still shaped like the org default counts as seeded ---
{
  const r = rig({ stored: week({ hours_source: null, hours_set_at: null }) });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind, "imported", "an unstamped week shaped exactly like the org default is the seed, and is imported");
  eq(r.orgReads, 1, "the org default is read only to judge an unstamped row");
}

// --- a week somebody set is left alone, and cal.com is not even asked ---
for (const source of ["agent", "admin", "calcom-import"] as const) {
  const r = rig({ stored: week({ hours_source: source }) });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out, { kind: "skipped", reason: "hours-already-set", detail: `hours_source is ${source}` },
    `a week stamped ${source} is not replaced`);
  eq(r.writes.length, 0, `no write over a ${source} week`);
  eq(r.calcomCalls.length, 0, `no cal.com call for a ${source} week (nothing to import it into)`);
}
{
  // Unstamped and NOT the org default's shape: somebody set it before the stamp existed.
  const r = rig({
    stored: week({ hours_source: null, hours_set_at: null, rules: [{ weekday: 1, start_minute: 540, end_minute: 1020 }] }),
  });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind === "skipped" && out.reason, "hours-already-set", "an unstamped week differing from the org default is left alone");
  eq(r.writes.length, 0, "no write over an unstamped hand set week");
}
{
  // Same rules, different zone: that is a choice too.
  const r = rig({ stored: week({ hours_source: null, hours_set_at: null, timezone: "America/Phoenix" }) });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind === "skipped" && out.reason, "hours-already-set", "an unstamped week in another zone is left alone");
}

// --- every cal.com failure leaves the seeded week, logs its own reason, never throws ---
const failures: [ScheduleForImportRead, string][] = [
  [{ kind: "not-configured" }, "calcom-not-configured"],
  [{ kind: "loadtest" }, "loadtest"],
  [{ kind: "no-account" }, "no-calcom-account"],
  [{ kind: "no-schedule" }, "no-calcom-schedule"],
  [{ kind: "rate-limited" }, "calcom-rate-limited"],
  [{ kind: "refused", status: 503 }, "calcom-refused"],
  [{ kind: "unreachable", detail: "The operation was aborted due to timeout" }, "calcom-unreachable"],
  [{ kind: "unreadable", why: "the user lookup did not answer a list" }, "calcom-unreadable"],
];
const seenReasons = new Set<string>();
for (const [cal, reason] of failures) {
  const r = rig({ cal });
  let threw = false;
  let out;
  try {
    out = await importHoursOnActivation(AGENT, r.deps);
  } catch {
    threw = true;
  }
  assert(!threw, `${cal.kind}: never throws, so activation goes ahead`);
  eq(out?.kind === "skipped" && out.reason, reason, `${cal.kind} is skipped as ${reason}`);
  eq(r.writes.length, 0, `${cal.kind}: the seeded week is left as it is`);
  const warn = r.logs.find((l) => l.fields.reason !== undefined);
  eq(warn?.fields.reason, reason, `${cal.kind}: the log line carries its own reason`);
  seenReasons.add(reason);
}
eq(seenReasons.size, failures.length, "no two cal.com failures share a reason");

// --- a cal.com week Slate will not accept is refused, not half written ---
{
  const r = rig({ cal: { kind: "schedule", schedule: { timeZone: "Mars/Olympus", availability: [] } } });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind === "skipped" && out.reason, "schedule-not-importable", "an unmappable schedule is skipped with its own reason");
  eq(r.writes.length, 0, "and nothing is written");
}

// --- Slate side failures are contained too ---
{
  const r = rig({ stored: "throw" });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind === "skipped" && out.reason, "slate-read-failed", "an unreadable schedule row is skipped, not thrown");
  eq(r.calcomCalls.length, 0, "and cal.com is not asked about a week nobody could read");
}
{
  const r = rig({ stored: null });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind === "skipped" && out.reason, "no-schedule-row", "an agent with no schedule row is skipped by name");
}
{
  const r = rig({ stored: week({ hours_source: null, hours_set_at: null }), org: "throw" });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind === "skipped" && out.reason, "slate-read-failed", "an unreadable org default cannot judge an unstamped row, so it is skipped");
  eq(r.calcomCalls.length, 0, "without spending a cal.com call");
}
{
  const r = rig({ writeThrows: true });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind === "skipped" && out.reason, "write-failed", "a refused write is skipped with its own reason, not thrown");
}

// --- #2702: a week edited while the import ran is never overwritten ---
// The check above and the write below are two steps, so an admin save landing
// between them used to be overwritten with nothing said. The write now names the
// source the check read, and the database refuses when it changed.
{
  const r = rig();
  await importHoursOnActivation(AGENT, r.deps);
  eq(r.guards, ["seed"], "the write is guarded on the source the check read");
}
{
  const r = rig({ stored: week({ hours_source: null, hours_set_at: null }) });
  await importHoursOnActivation(AGENT, r.deps);
  eq(r.guards, [null], "an unstamped seed is guarded as still unstamped, never written unguarded");
}
{
  const r = rig({ writeRaced: true });
  let threw = false;
  let out;
  try {
    out = await importHoursOnActivation(AGENT, r.deps);
  } catch {
    threw = true;
  }
  assert(!threw, "a week edited mid import never throws, so activation goes ahead");
  eq(out?.kind === "skipped" && out.reason, "hours-changed-during-import",
    "a week edited while the import ran is its own reason, not a failed write");
  const line = r.logs.find((l) => l.fields.reason !== undefined);
  eq(line?.fields.reason, "hours-changed-during-import", "the log line names it");
  eq(line?.level, "info", "logged quietly: somebody set the week, so nothing is left wrong");
}
{
  // Control: an ordinary refusal still reads as write-failed and warns.
  const r = rig({ writeThrows: true });
  await importHoursOnActivation(AGENT, r.deps);
  const line = r.logs.find((l) => l.fields.reason !== undefined);
  eq(line?.fields.reason, "write-failed", "control: a refused write is still write-failed");
  eq(line?.level, "warn", "control: and still warns");
}

// --- bounded by what is left of the activation budget ---
{
  const r = rig({ remainingMs: [500] });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind === "skipped" && out.reason, "out-of-budget", "too little budget left: skipped before any read");
  eq(r.calcomCalls.length, 0, "no cal.com call on an exhausted budget");
}
{
  const r = rig({ remainingMs: [30_000] });
  await importHoursOnActivation(AGENT, r.deps);
  assert(r.calcomCalls[0].timeoutMs > 0 && r.calcomCalls[0].timeoutMs <= 5_000,
    `each cal.com call carries a short deadline (got ${r.calcomCalls[0].timeoutMs})`);
}
{
  // Plenty before the read, nothing left after it: the write is not started.
  // Readings: at the start, just before the cal.com read, just before the write.
  const r = rig({ remainingMs: [30_000, 30_000, 0] });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind === "skipped" && out.reason, "out-of-budget", "a read that spent the budget does not go on to write");
  eq(r.writes.length, 0, "no write after the budget ran out");
}
{
  // The Slate reads spend budget too: 30s at the start, 3s left once the schedule
  // and org default have been read. The cal.com deadline must come from the 3s.
  const r = rig({ remainingMs: [30_000, 3_000] });
  await importHoursOnActivation(AGENT, r.deps);
  eq(r.calcomCalls.length, 1, "control: cal.com is still asked with 3s left");
  assert(r.calcomCalls[0].timeoutMs * 2 <= 3_000,
    `the cal.com deadline is half of what is left AFTER the Slate reads (got ${r.calcomCalls[0].timeoutMs}ms against 3000ms left)`);
}
{
  // And when the Slate reads spent nearly all of it, cal.com is not started at all.
  const r = rig({ remainingMs: [30_000, 400] });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind === "skipped" && out.reason, "out-of-budget", "too little left after the Slate reads: skipped before cal.com");
  eq(r.calcomCalls.length, 0, "no cal.com call once the Slate reads have spent the budget");
}
{
  // The deadline is shared across both calls, so each gets at most half of what is left.
  const r = rig({ remainingMs: [3_000] });
  await importHoursOnActivation(AGENT, r.deps);
  assert(r.calcomCalls[0].timeoutMs * 2 <= 3_000, "two calls at the given timeout fit inside the remaining budget");
}

// --- #2875: once cal.com is retired, a new hire's week is never asked of it ---------
// After cutover cal.com holds nothing anybody maintains, so importing from it would
// put a stale or empty week over the seed; the hire sets their own hours in Slate.
{
  const r = rig({ retired: true });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind === "skipped" && out.reason, "calcom-retired", "retired: skipped with its own reason");
  eq(r.calcomCalls.length, 0, "retired: cal.com is not asked");
  eq(r.writes.length, 0, "retired: nothing is written");
  eq(r.logs[0]?.level, "info", "retired: a normal state, logged quietly rather than as a week left wrong");
}
for (const retired of [null, "throw"] as const) {
  // Unreadable falls CLOSED, like the daily importer: this write replaces a Slate
  // week, and a missed import is repaired by the next run while an overwrite is not.
  const r = rig({ retired });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind === "skipped" && out.reason, "calcom-retired-unreadable", `retired read ${String(retired)}: skipped, in its own words`);
  eq(r.calcomCalls.length, 0, `retired read ${String(retired)}: cal.com is not asked`);
  eq(r.writes.length, 0, `retired read ${String(retired)}: nothing is written`);
  eq(r.logs[0]?.level, "warn", `retired read ${String(retired)}: warned, because the week stays on the seed`);
}
{
  const r = rig({ retired: false });
  const out = await importHoursOnActivation(AGENT, r.deps);
  eq(out.kind, "imported", "live: the seeded week is imported, as today");
}

finish();
