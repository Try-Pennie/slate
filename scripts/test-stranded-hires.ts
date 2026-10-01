// #2481: a hire stranded outside the pool with no pending mark and no recorded
// hold. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/test-stranded-hires.ts
//
// The fix for #2381 stopped the hourly roster write erasing
// `bookable_pending_since`, and repaired nothing it had already erased. Measured on
// 2026-09-16, two Sales hires had signed in, had a calendar that synced, carried a
// debt tier, and were not bookable with no pending mark and no audit row: they read
// exactly like somebody an admin held back on purpose (L60), and the waiting alert
// (#2318) reads the mark, so it is blind to them by construction.
//
// What is pinned: the shape is judged through the predicates that already exist
// (who counts as WAITING is `agentsAwaitingActivation`, who is on Sales with no
// recorded hold is `onSalesWithNoRecordedHold`), never a third spelling of either;
// every exclusion fires in both directions; a read that failed measures nothing and
// clears nothing; and the all clear hangs off a measured empty answer.
import {
  strandedHireCandidates,
  strandedHires,
  runStrandedHiresCheck,
  formatStrandedHiresAlert,
  formatStrandedHiresRecovery,
  STRANDED_HIRES_KEY,
  type StrandedHireRow,
  type StrandedHiresDeps,
} from "@/lib/monitor/stranded-hires";
import { assert, eq, finish } from "./lib/harness.ts";

function row(over: Partial<StrandedHireRow> = {}): StrandedHireRow {
  return {
    id: "u1",
    name: "Robin Example",
    email: "rexample@trypennie.com",
    attributes: { role: "Sales", debt_team: ["low"] },
    bookable: false,
    deactivated_at: null,
    bookable_pending_since: null,
    auth_user_id: "auth-1",
    ...over,
  };
}

// ---- the candidate shape ---------------------------------------------------
{
  eq(strandedHireCandidates([row()]).map((r) => r.id), ["u1"], "the damaged shape is a candidate");
  const cases: [Partial<StrandedHireRow>, string][] = [
    [{ bookable: true }, "a bookable agent is not stranded"],
    [{ deactivated_at: "2026-09-20T00:00:00Z" }, "somebody who left is not stranded"],
    [{ bookable_pending_since: "2026-09-30T09:00:00Z" }, "a pending mark is the waiting alert's, not this one's"],
    [{ auth_user_id: null }, "somebody who has never signed in has not started"],
    [{ attributes: { role: "Chatter Free User", debt_team: ["low"] } }, "off the Sales profile is a Salesforce edit nobody owes yet"],
    [{ attributes: { role: "Sales", redistribute: "Y" } }, "a Redistribute mark Slate wrote is a recorded hold"],
    [{ attributes: { role: "Sales", redistribute_tagged: "Y" } }, "a Redistribute tag in Twilio is a recorded hold"],
  ];
  for (const [over, msg] of cases) {
    eq(strandedHireCandidates([row(over)]).length, 0, msg);
  }
  // An empty mark is no mark, exactly as the waiting check reads it.
  eq(strandedHireCandidates([row({ bookable_pending_since: "" })]).length, 1,
    "an empty pending mark reads as no mark, as agentsAwaitingActivation reads it");
}

// ---- the narrowing reads ---------------------------------------------------
{
  const cands = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];
  const out = strandedHires(cands, new Set(["a", "b"]), new Set(["b"]));
  eq(out.map((s) => s.id), ["a"],
    "stranded needs a calendar that synced and no person having decided about their bookable state");
  eq(strandedHires(cands, new Set(), new Set()).length, 0, "nobody without a synced calendar is named");
}

// ---- the copy ----------------------------------------------------------------
{
  const text = formatStrandedHiresAlert([
    { id: "a", name: "Robin Example", email: "rexample@trypennie.com" },
    { id: "b", name: null, email: "kalvarez@trypennie.com" },
  ]);
  assert(text.startsWith("2 agents"), "the count leads");
  assert(text.includes("Robin Example (rexample@trypennie.com)"), "names each person");
  assert(text.includes("kalvarez@trypennie.com"), "and falls back to the address");
  assert(text.includes("Make bookable"), "names the repair that runs the activation");
  assert(text.includes("Redistribute"), "and the way to record a deliberate hold");
  assert(!/[\u2014\u2013]/.test(text), "carries no dash");
  assert(!text.startsWith("Slate"), "does not open with the app name");
  const many = formatStrandedHiresAlert(
    Array.from({ length: 11 }, (_, i) => ({ id: `x${i}`, name: `Person ${i}`, email: null })),
  );
  assert(many.includes("(and 3 more)"), "caps the names and says how many more");
  assert(formatStrandedHiresAlert([{ id: "a", name: null, email: null }]).startsWith("1 agent is"), "singular reads singular");
  assert(formatStrandedHiresRecovery().length > 0, "the all clear says something");
}

// ---- the runner ------------------------------------------------------------
type Calls = { notified: string[]; resolved: string[]; reads: string[] };
function deps(over: Partial<StrandedHiresDeps> = {}, rows: StrandedHireRow[] = [row()]): StrandedHiresDeps & Calls {
  const calls: Calls = { notified: [], resolved: [], reads: [] };
  return {
    ...calls,
    loadCandidates: async () => {
      calls.reads.push("candidates");
      return rows;
    },
    loadSyncedCalendarUserIds: async (ids) => {
      calls.reads.push("calendars");
      return new Set(ids);
    },
    loadDecidedUserIds: async () => {
      calls.reads.push("audit");
      return new Set();
    },
    notify: async (key) => {
      calls.notified.push(key);
    },
    resolve: async (key) => {
      calls.resolved.push(key);
      return true;
    },
    cooldownMs: 6 * 60 * 60_000,
    ...over,
  };
}

async function main(): Promise<void> {
  {
    const d = deps();
    const r = await runStrandedHiresCheck(d);
    eq(r.status, "stranded", "the damaged shape pages");
    eq(d.notified, [STRANDED_HIRES_KEY], "on its own key");
    eq(d.resolved, [], "and clears nothing");
  }
  {
    const d = deps({}, [row({ bookable: true })]);
    const r = await runStrandedHiresCheck(d);
    eq(r, { status: "clear", measured: 1 }, "a measured roster with nobody stranded is clear");
    eq(d.resolved, [STRANDED_HIRES_KEY], "and sends the all clear");
    eq(d.reads, ["candidates"], "and spends no further read when there is no candidate");
  }
  {
    const d = deps({ loadDecidedUserIds: async () => new Set(["u1"]) });
    const r = await runStrandedHiresCheck(d);
    eq(r.status, "clear", "a person's recorded decision takes them out");
  }
  for (const which of ["loadCandidates", "loadSyncedCalendarUserIds", "loadDecidedUserIds"] as const) {
    const d = deps({
      [which]: async () => {
        throw new Error(`${which} refused`);
      },
    });
    const r = await runStrandedHiresCheck(d);
    eq(r, { status: "unreadable", error: `${which} refused` }, `a failed ${which} read is unreadable`);
    eq(d.notified, [], `and pages nobody (${which})`);
    eq(d.resolved, [], `and clears nothing, because it measured nothing (${which})`);
  }
  {
    // A flaky Slack must never fail the tick.
    const d = deps({
      notify: async () => {
        throw new Error("slack down");
      },
    });
    const r = await runStrandedHiresCheck(d);
    eq(r.status, "stranded", "a notify that throws still returns the measured answer");
  }
  finish();
}

void main();
