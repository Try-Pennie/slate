// #3489: the ladder read's answer, read strictly, and the windows a confirm sends.
//
// `ladder_candidate_inputs` (0176) returns, in one request, the rows the candidate read
// made seven to nine requests for on every rung. Two things here decide whether a rung
// judged from it can be wrong without anybody seeing:
//
//   - the READER (`ladderInputsFrom`). Each section read as empty when it could not be
//     read is the permissive answer: nobody busy, nobody held, no hours narrowed, every
//     advisor offered (#277, L50). So every way a section can be unreadable throws, by
//     name, and a well formed answer is read whole.
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
  agents: [{ id: "a", org_id: "org1", attributes: { debt_team: ["high"] } }, { id: "z", org_id: "org2", attributes: {} }],
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
  eq(r.shares.length, 2, "reader: a share row with no advisor is kept, for the share's own reduction to skip");
  assert(r.covers(minutes(START, -10), minutes(START, 30)), "covers: the requested rung's own window");
  assert(!r.covers(minutes(windows.busyFrom, -1), minutes(START, 30)), "covers: not a window starting before the read's");
  assert(!r.covers(minutes(START, -10), minutes(windows.busyTo, 1)), "covers: not one ending after it");
}

// --- the reader: every unreadable answer throws, by name -----------------------------
type Breaker = [string, (d: ReturnType<typeof good>) => unknown, RegExp];
const breakers: Breaker[] = [
  ["no answer at all", () => null, /not an object/],
  ["a list where the answer belongs", () => [], /not an object/],
  ["a missing section", (d) => ({ ...d, busy: undefined }), /busy is not a list/],
  ["a section that is not a list", (d) => ({ ...d, holds: {} }), /holds is not a list/],
  ["a row that is not a row", (d) => ({ ...d, agents: ["a"] }), /agents\[0\] is not a row/],
  ["a bucket with no code", (d) => ({ ...d, buckets: [{ ...d.buckets[0], code: "" }] }), /buckets\[0\]/],
  ["an advisor with no attributes", (d) => ({ ...d, agents: [{ id: "a", org_id: "org1", attributes: null }] }), /agents\[0\]/],
  ["a member with no advisor", (d) => ({ ...d, members: [{ bucket_id: "b500" }] }), /members\[0\]/],
  ["a schedule with no zone", (d) => ({ ...d, schedules: [{ ...d.schedules[0], timezone: null }] }), /schedules\[0\]/],
  ["a rule with a minute that is not a number", (d) => ({ ...d, schedules: [{ ...d.schedules[0], availability_rules: [{ schedule_id: "s-a", weekday: 2, start_minute: "nine", end_minute: 1020 }] }] }), /schedules\[0\]/],
  ["busy time whose end does not parse", (d) => ({ ...d, busy: [{ ...d.busy[0], ends_at: "soon" }] }), /busy\[0\]/],
  ["busy time with no source", (d) => ({ ...d, busy: [{ ...d.busy[0], source: undefined }] }), /busy\[0\]/],
  ["counts that are not an object", (d) => ({ ...d, day_counts: null }), /day_counts/],
  ["a hold whose window does not parse", (d) => ({ ...d, holds: [{ ...d.holds[0], buffered_ends_at: "x" }] }), /holds\[0\]/],
  ["a share whose start does not parse", (d) => ({ ...d, shares: [{ ...d.shares[0], starts_at: "x" }] }), /shares\[0\]/],
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

finish();
