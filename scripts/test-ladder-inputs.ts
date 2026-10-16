// #3489: the ladder read's answer, read strictly, and the windows a confirm sends.
//
// `ladder_candidate_inputs` (0176) returns, in one request, the rows the candidate read
// made seven to nine requests for on every rung. Two things here decide whether a rung
// judged from it can be wrong without anybody seeing:
//
//   - the READER (`ladderInputsFrom`). Each section read as empty when it could not be
//     read is the permissive answer: nobody busy, nobody held, no hours narrowed, every
//     advisor offered (#277, L50). So a section it cannot read, an org wide row it
//     cannot read and a row naming nobody each throw, by name; a row that names its
//     advisor and is otherwise unreadable drops that WHOLE advisor and nobody else
//     (#3530), never just the row; and a well formed answer is read whole.
//   - the WINDOWS (`ladderWindows`). Busy time and holds are read over a superset of the
//     requested rung's buffered window; the cap count a day either side of that, the
//     rule the count already had; the share over the slot's two pay periods, as
//     `rankBucketShare` reads them; the exceptions from today in the business zone.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-ladder-inputs.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  LADDER_WINDOW_SLACK_MIN,
  LadderInputsUnreadableError,
  ladderInputsFrom,
  ladderWindows,
} from "../src/lib/availability/ladder-inputs.ts";
import { capCountWindow } from "../src/lib/availability/compute.ts";
import { payPeriod } from "../src/lib/availability/roundrobin.ts";
import { eligibleFromRoster } from "../src/lib/availability/pool.ts";

const EVENT = { duration_min: 20, buffer_before_min: 10, buffer_after_min: 10 };
const START = "2031-03-04T16:00:00.000Z";
const NOW = Date.parse("2031-03-04T03:30:00.000Z"); // 22:30 on the 3rd in New York
const minutes = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();

// --- the windows ------------------------------------------------------------------
{
  const w = ladderWindows(START, EVENT, NOW);
  const rungFrom = minutes(START, -10);
  const rungTo = minutes(START, 30);
  eq(w.busyFrom, minutes(rungFrom, -LADDER_WINDOW_SLACK_MIN), "windows: busy time from the rung's buffered start, less the slack");
  eq(w.busyTo, minutes(rungTo, LADDER_WINDOW_SLACK_MIN), "windows: to the rung's buffered end, plus the slack");
  const cap = capCountWindow(w.busyFrom, w.busyTo);
  assert(w.capFrom === cap.from && w.capTo === cap.to, "windows: the cap count a day either side of the busy window, the count's own rule");
  const rungCap = capCountWindow(rungFrom, rungTo);
  assert(Date.parse(w.capFrom) <= Date.parse(rungCap.from) && Date.parse(w.capTo) >= Date.parse(rungCap.to), "windows: the cap window holds the rung's own cap window");
  const period = payPeriod(Date.parse(START));
  eq(w.shareFrom, new Date(payPeriod(period.startMs - 1).startMs).toISOString(), "windows: the share from the start of the period before the slot's");
  eq(w.shareTo, new Date(period.endMs).toISOString(), "windows: to the end of the slot's period");
  eq(w.exceptionsFrom, "2031-03-03", "windows: the exceptions from TODAY in the business zone, not in UTC (22:30 New York is the 4th in UTC)");
}

// --- the reader: a well formed answer ----------------------------------------------
const windows = ladderWindows(START, EVENT, NOW);
const good = () => ({
  buckets: [
    { id: "b500", org_id: "org1", code: "500", criteria: {}, event_types: { id: "e1", duration_min: 20 } },
    { id: "b400", org_id: "org1", code: "400", criteria: {}, event_types: null },
  ],
  agents: [
    { id: "a", org_id: "org1", attributes: { debt_team: ["high"] }, email: "a@example.com", name: "Agent A", bookable: true },
    { id: "z", org_id: "org2", attributes: {}, email: "z@example.com", name: "Agent Z", bookable: true },
  ],
  members: [{ bucket_id: "b500", user_id: "a" }],
  schedules: [{ id: "s-a", user_id: "a", timezone: "America/New_York", availability_rules: [{ schedule_id: "s-a", weekday: 2, start_minute: 540, end_minute: 1020 }] }],
  busy: [{ user_id: "a", starts_at: minutes(START, 0), ends_at: minutes(START, 20), source: "gcal" }],
  day_counts: { "a|2031-03-04": 2 },
  holds: [{ agent_user_id: "a", booking_id: "k", booking_starts_at: START, booking_ends_at: minutes(START, 20), buffered_starts_at: minutes(START, -10), buffered_ends_at: minutes(START, 30) }],
  shares: [{ bucket_id: "b500", assigned_user_id: "a", starts_at: START, created_at: minutes(START, -600) }, { bucket_id: "b500", assigned_user_id: null, starts_at: START, created_at: START }],
  business_hours: [{ weekday: 2, is_open: true, start_minute: 480, end_minute: 1200 }],
  exceptions: [{ on_date: "2031-03-10", is_open: false, start_minute: null, end_minute: null, note: "closed" }],
});
{
  const r = ladderInputsFrom(good(), windows);
  eq(r.bucket("500")?.bucket.code, "500", "reader: a rung's bucket, by code");
  eq(r.bucket("500")?.eventType.id, "e1", "reader: with its event type, out of the bucket row");
  assert(r.bucket("500") !== null && !("event_types" in (r.bucket("500")!.bucket as object)), "reader: the nested event type is not left on the bucket");
  eq(r.bucket("400"), null, "reader: a bucket with no event type is no bucket to book, as the bucket read answers");
  eq(r.bucket("300"), null, "reader: a code with no row is null");
  eq(r.orgAgents("org1").map((a) => a.id).join(","), "a", "reader: the roster, by org");
  eq(r.orgAgents("nobody").length, 0, "reader: an org with nobody bookable has nobody");
  assert(r.membersOf("b500").has("a") && r.membersOf("b400").size === 0, "reader: active members, by bucket");
  eq(r.rules.length, 1, "reader: the rules, out of their schedules");
  eq(r.user("a")?.name, "Agent A", "reader: an advisor's whole row, as the advisor read returns it");
  eq(r.user("nobody"), null, "reader: nobody the read did not hold");
  eq(JSON.stringify([...r.emails(["a", "nobody"])]), JSON.stringify([["a", "a@example.com"]]), "reader: the emails of the advisors it holds, nobody else, as the emails read answers");
  const pool = r.pool({ id: "b500", org_id: "org1", criteria: { debt_team: ["high"] } });
  assert(
    JSON.stringify(pool.orgAgents.map((a) => a.id)) === JSON.stringify(["a"]) && pool.manualMemberIds.has("a") && JSON.stringify(pool.criteria) === JSON.stringify({ debt_team: ["high"] }),
    "reader: a bucket's raw pool, as the pool read gives it: its org's roster, its members, its criteria",
  );
  eq(r.shares.length, 2, "reader: a share row with no advisor is kept, for the share's own reduction to skip");
  assert(r.covers(minutes(START, -10), minutes(START, 30)), "covers: the requested rung's own window");
  assert(!r.covers(minutes(windows.busyFrom, -1), minutes(START, 30)), "covers: not a window starting before the read's");
  assert(!r.covers(minutes(START, -10), minutes(windows.busyTo, 1)), "covers: not one ending after it");
}

// --- the reader: an answer it cannot read at all throws, by name ---------------------
// A section missing, a row that is not a row, an org wide row (a bucket, the week, an
// exception) it cannot read, or a row naming NOBODY: busy time, a hold or a count it
// cannot attribute to an advisor could belong to anybody, so nobody can be judged.
type Breaker = [string, (d: ReturnType<typeof good>) => unknown, RegExp];
const breakers: Breaker[] = [
  ["no answer at all", () => null, /not an object/],
  ["a list where the answer belongs", () => [], /not an object/],
  ["a missing section", (d) => ({ ...d, busy: undefined }), /busy is not a list/],
  ["a section that is not a list", (d) => ({ ...d, holds: {} }), /holds is not a list/],
  ["a row that is not a row", (d) => ({ ...d, agents: ["a"] }), /agents\[0\] is not a row/],
  ["a bucket with no code", (d) => ({ ...d, buckets: [{ ...d.buckets[0], code: "" }] }), /buckets\[0\]/],
  ["an advisor row with no id", (d) => ({ ...d, agents: [{ ...d.agents[0]!, id: null }] }), /agents\[0\]/],
  ["a member with no advisor", (d) => ({ ...d, members: [{ bucket_id: "b500" }] }), /members\[0\]/],
  ["a schedule with no advisor", (d) => ({ ...d, schedules: [{ ...d.schedules[0], user_id: null }] }), /schedules\[0\]/],
  ["busy time naming no advisor", (d) => ({ ...d, busy: [{ ...d.busy[0], user_id: "" }] }), /busy\[0\]/],
  ["counts that are not an object", (d) => ({ ...d, day_counts: null }), /day_counts/],
  ["a count naming no advisor", (d) => ({ ...d, day_counts: { "2031-03-04": 2 } }), /day_counts/],
  ["a hold naming no advisor", (d) => ({ ...d, holds: [{ ...d.holds[0], agent_user_id: undefined }] }), /holds\[0\]/],
  ["a share with no advisor whose start does not parse", (d) => ({ ...d, shares: [d.shares[0], { ...d.shares[1], starts_at: "x" }] }), /shares\[1\]/],
  ["a business day with no open flag", (d) => ({ ...d, business_hours: [{ weekday: 2, start_minute: 480, end_minute: 1200 }] }), /business_hours\[0\]/],
  ["an exception with no date", (d) => ({ ...d, exceptions: [{ is_open: false }] }), /exceptions\[0\]/],
];
for (const [what, breaks, says] of breakers) {
  let thrown: unknown = null;
  try {
    ladderInputsFrom(breaks(good()), windows);
  } catch (err) {
    thrown = err;
  }
  assert(
    thrown instanceof LadderInputsUnreadableError && says.test((thrown as Error).message),
    `reader: ${what} throws, naming it (got ${thrown instanceof Error ? thrown.message : String(thrown)})`,
  );
}

// --- the reader: one advisor's bad row drops THAT advisor, and only them (#3530) -----
// It used to throw for the whole org, so one malformed row failed every confirm on every
// ladder. Skipping just the row would be worse: a busy block, a hold or a count left out
// makes the advisor look FREE (#277, L50), and the next lead is booked over a call they
// already have. So the whole advisor goes: off the roster, so out of every pool (as a
// manual member and as a bucket's fallback too), with every other row of theirs, and
// named in `dropped` so the confirm logs it and the monitor lane pages it.
//
// `b` shares the org and the bucket with `a`, so each case also proves everybody else
// still answers from the same read.
const withB = () => {
  const d = good();
  return {
    ...d,
    agents: [...d.agents, { id: "b", org_id: "org1", attributes: { debt_team: ["high"] }, email: "b@example.com", name: "Agent B", bookable: true }],
    members: [...d.members, { bucket_id: "b500", user_id: "b" }],
    schedules: [...d.schedules, { id: "s-b", user_id: "b", timezone: "America/Chicago", availability_rules: [{ schedule_id: "s-b", weekday: 2, start_minute: 540, end_minute: 1020 }] }],
    busy: [...d.busy, { user_id: "b", starts_at: minutes(START, 60), ends_at: minutes(START, 80), source: "gcal" }],
    day_counts: { ...d.day_counts, "b|2031-03-04": 1 },
    holds: [...d.holds, { ...d.holds[0]!, agent_user_id: "b", booking_id: "kb" }],
    shares: [...d.shares, { bucket_id: "b500", assigned_user_id: "b", starts_at: START, created_at: minutes(START, -300) }],
  };
};
type Dropper = [string, (d: ReturnType<typeof withB>) => unknown, RegExp];
const droppers: Dropper[] = [
  ["an advisor with no attributes", (d) => ({ ...d, agents: [{ ...d.agents[0]!, attributes: null }, ...d.agents.slice(1)] }), /agents: no readable org, attributes or email/],
  ["an advisor with no email", (d) => ({ ...d, agents: [{ ...d.agents[0]!, email: "" }, ...d.agents.slice(1)] }), /agents: no readable org, attributes or email/],
  ["a member row with no bucket", (d) => ({ ...d, members: [{ user_id: "a" }, ...d.members.slice(1)] }), /members: no readable bucket/],
  ["a schedule with no zone", (d) => ({ ...d, schedules: [{ ...d.schedules[0]!, timezone: null }, d.schedules[1]!] }), /schedules: no readable id, zone or rules/],
  ["a schedule in a zone nobody can read", (d) => ({ ...d, schedules: [{ ...d.schedules[0]!, timezone: "Mars/Olympus_Mons" }, d.schedules[1]!] }), /schedules: no readable id, zone or rules/],
  ["a rule with a minute that is not a number", (d) => ({ ...d, schedules: [{ ...d.schedules[0]!, availability_rules: [{ schedule_id: "s-a", weekday: 2, start_minute: "nine", end_minute: 1020 }] }, d.schedules[1]!] }), /schedules: no readable rule/],
  ["busy time whose end does not parse", (d) => ({ ...d, busy: [{ ...d.busy[0]!, ends_at: "soon" }, d.busy[1]!] }), /busy: no readable bounds or source/],
  ["busy time with no source", (d) => ({ ...d, busy: [{ ...d.busy[0]!, source: undefined }, d.busy[1]!] }), /busy: no readable bounds or source/],
  ["a count that is not a whole number", (d) => ({ ...d, day_counts: { ...d.day_counts, "a|2031-03-04": "2" } }), /day_counts: no readable day or count/],
  ["a count on a day that does not read", (d) => ({ ...d, day_counts: { "a|someday": 2, "b|2031-03-04": 1 } }), /day_counts: no readable day or count/],
  ["a hold whose window does not parse", (d) => ({ ...d, holds: [{ ...d.holds[0]!, buffered_ends_at: "x" }, d.holds[1]!] }), /holds: no readable booking or window/],
  ["a share whose start does not parse", (d) => ({ ...d, shares: [{ ...d.shares[0]!, starts_at: "x" }, ...d.shares.slice(1)] }), /shares: no readable bucket or instants/],
];
// Control (L1): the same answer with nothing broken drops nobody and holds both.
{
  const r = ladderInputsFrom(withB(), windows);
  eq(r.dropped.length, 0, "drop control: a well formed answer drops nobody");
  eq(r.orgAgents("org1").map((a) => a.id).join(","), "a,b", "drop control: both advisors are on the roster");
  eq(eligibleFromRoster({ criteria: {}, fallback_user_id: null }, r.orgAgents("org1"), r.membersOf("b500")).ids.join(","), "a,b", "drop control: both are in the bucket's pool");
}
for (const [what, breaks, says] of droppers) {
  let r: ReturnType<typeof ladderInputsFrom> | null = null;
  let thrown: unknown = null;
  try {
    r = ladderInputsFrom(breaks(withB()), windows);
  } catch (err) {
    thrown = err;
  }
  if (!r) {
    assert(false, `drop: ${what} must drop the advisor, not fail the read for everybody (threw ${thrown instanceof Error ? thrown.message : String(thrown)})`);
    continue;
  }
  const dropped = r.dropped.find((x) => x.id === "a");
  assert(r.dropped.length === 1 && dropped !== undefined && dropped.why.some((w) => says.test(w)), `drop: ${what} drops that advisor, saying why (got ${JSON.stringify(r.dropped)})`);
  assert(dropped?.name === "Agent A", `drop: ${what} names them, so a page can say who (got ${dropped?.name})`);
  // Out of every pool: as a criteria match, as a manual member, and as the fallback.
  assert(!r.orgAgents("org1").some((x) => x.id === "a"), `drop: ${what} takes them off the roster`);
  eq(eligibleFromRoster({ criteria: { debt_team: ["high"] }, fallback_user_id: null }, r.orgAgents("org1"), r.membersOf("b500")).ids.join(","), "b", `drop: ${what} leaves them out of the bucket's pool, by criteria and as a member`);
  eq(eligibleFromRoster({ criteria: { debt_team: ["nobody"] }, fallback_user_id: "a" }, r.orgAgents("org1"), new Set()).ids.length, 0, `drop: ${what} never books them as a bucket's fallback`);
  eq(r.user("a"), null, `drop: ${what} holds no row for them`);
  eq(r.emails(["a", "b"]).has("a"), false, `drop: ${what} has no email for them`);
  // Every other row of theirs goes too, so nothing judges them from half a picture.
  assert(!r.schedules.some((x) => x.user_id === "a") && !r.rules.some((x) => x.schedule_id === "s-a"), `drop: ${what} drops their schedule and rules`);
  assert(!r.busy.some((x) => x.user_id === "a") && !r.holds.some((x) => x.agent_user_id === "a") && !r.shares.some((x) => x.assigned_user_id === "a"), `drop: ${what} drops their busy time, holds and shares`);
  assert(!Object.keys(r.dayCounts as object).some((k) => k.startsWith("a|")), `drop: ${what} drops their counts`);
  // Everybody else answers from the same read, rows and all.
  assert(r.orgAgents("org1").some((x) => x.id === "b") && r.orgAgents("org2").some((x) => x.id === "z"), `drop: ${what} keeps every other advisor, in every org`);
  assert(r.user("b")?.email === "b@example.com" && r.emails(["b"]).get("b") === "b@example.com", `drop: ${what} keeps the others' rows`);
  assert(
    r.schedules.some((x) => x.user_id === "b") && r.busy.some((x) => x.user_id === "b") && r.holds.some((x) => x.agent_user_id === "b") &&
      r.shares.some((x) => x.assigned_user_id === "b") && (r.dayCounts as Record<string, number>)["b|2031-03-04"] === 1,
    `drop: ${what} keeps the others' schedule, busy time, holds, shares and counts`,
  );
  assert(r.bucket("500") !== null && r.businessHours.length === 1, `drop: ${what} keeps the buckets and the week`);
}
{
  // Two bad rows of one advisor are one drop, with both reasons.
  const d = withB();
  const r = ladderInputsFrom({ ...d, busy: [{ ...d.busy[0]!, ends_at: "x" }, d.busy[1]!], holds: [{ ...d.holds[0]!, buffered_ends_at: "x" }, d.holds[1]!] }, windows);
  assert(r.dropped.length === 1 && r.dropped[0]!.why.length === 2, `drop: two bad rows of one advisor are one drop with two reasons (got ${JSON.stringify(r.dropped)})`);
  // A bad row of somebody with no roster row is still named, by id, with no name.
  const s = ladderInputsFrom({ ...d, busy: [...d.busy, { user_id: "ghost", starts_at: "x", ends_at: "y", source: "gcal" }] }, windows);
  assert(s.dropped.length === 1 && s.dropped[0]!.id === "ghost" && s.dropped[0]!.name === null, `drop: a bad row of somebody off the roster names them by id (got ${JSON.stringify(s.dropped)})`);
}

finish();
