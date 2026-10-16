// #3530: the one ladder read a walk makes (#3489) is never trusted past its age bound.
//
// One read serves every rung, so a lower rung used to be judged from busy time, day
// counts and holds read BEFORE the live Google checks on the rungs above it, which can
// take seconds. In those seconds another confirm can book the same advisor's day, a
// reroute can hold them, or they can stop being bookable, and the stale read still
// offers them. So a rung judged once the read is older than `LADDER_READ_MAX_AGE_MS`
// is judged from a fresh read, and a walk that spends no real time pays nothing extra.
//
// The walk here: the requested rung's only advisor (`a`) is checked live and found
// busy, so the walk drops to the next rung, where `b` and `c` are free. Between the two
// reads `b` becomes unbookable, so the fresh read no longer holds them and the candidate
// read (which, as the real one does, only offers advisors the ladder read holds) cannot
// offer them. The live check on the rung above is what moves the clock.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-ladder-read-staleness.ts
import { createBooking } from "../src/lib/booking/orchestration.ts";
import { LADDER_READ_MAX_AGE_MS, type LadderInputs } from "../src/lib/availability/ladder-inputs.ts";
import { BOOKING_CONFIRM_BUDGET_MS } from "../src/lib/booking/confirm-budget.ts";
import { GOOGLE_CONFIRM_TIMEOUT_MS } from "../src/lib/google/calendar.ts";
import type { Booking, Bucket, User } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, input, users, bucket as fakeBucket, eventType as fakeEventType } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

/** A ladder read holding these advisors, labelled so a test can say which read judged. */
function ladderHolding(label: string, holds: readonly string[]): LadderInputs & { label: string } {
  return {
    label,
    bucket: (code: string) => ({ bucket: { ...fakeBucket, code } as Bucket, eventType: fakeEventType }),
    covers: () => true,
    pool: () => ({ orgAgents: holds.map((id) => ({ id, attributes: {} })), manualMemberIds: new Set(holds), criteria: {} }),
    user: (id: string) => (holds.includes(id) ? ((users[id] as User | undefined) ?? null) : null),
    emails: (ids: readonly string[]) => new Map(ids.flatMap((id) => (holds.includes(id) && users[id]?.email ? [[id, users[id]!.email] as [string, string]] : []))),
  } as unknown as LadderInputs & { label: string };
}

type Outcome = { booking: Booking | null; error: unknown; reads: number; judgedBy: Record<string, string[]> };

/**
 * Book 411 at the fixture's time, the live check on the requested rung taking
 * `checkMs` of (fake) clock. `reread` is what every read after the first answers.
 */
async function walk(checkMs: number, reread: () => Promise<LadderInputs> = async () => ladderHolding("second", ["a", "c"]), firstReadMs = 0): Promise<Outcome> {
  offsetMs = 0;
  const made = makeDeps({ candidatesByCode: { "411": ["a"], "311": ["b", "c"] }, freeEmails: new Set(["b@x.com", "c@x.com"]) });
  let reads = 0;
  made.deps.readLadderInputs = async () => {
    if (++reads > 1) return reread();
    offsetMs += firstReadMs; // the first read itself took this long to answer
    return ladderHolding("first", ["a", "b", "c"]);
  };
  // Which read each rung was judged from AFTER the live check moved the clock (a rung
  // below may also be read early, for the line, while the first read is still fresh),
  // and only the advisors that read holds are offered.
  const judgedBy: Record<string, string[]> = {};
  const candidates = made.deps.roundRobinCandidates;
  made.deps.roundRobinCandidates = async (b, e, ms, preview, only, excludeLow, opts) => {
    const res = await candidates(b, e, ms, preview, only, excludeLow, opts);
    const ladder = (opts as { inputs?: LadderInputs & { label: string } } | undefined)?.inputs;
    if (offsetMs > 0) (judgedBy[b.code] ??= []).push(ladder?.label ?? "none");
    return ladder ? { ...res, candidates: res.candidates.filter((id) => ladder.user(id) !== null) } : res;
  };
  const verify = made.deps.verifyFree;
  made.deps.verifyFree = async (emails, from, to, ids) => {
    if (emails.includes("a@x.com")) offsetMs += checkMs;
    return verify(emails, from, to, ids);
  };
  try {
    const res = await createBooking(input, made.deps);
    return { booking: (res.booking as Booking | undefined) ?? null, error: null, reads, judgedBy };
  } catch (err) {
    return { booking: null, error: err, reads, judgedBy };
  }
}

// The walk's clock: real time plus whatever the live checks are made to take.
const realNow = Date.now;
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;

async function main() {
  // The bound is derived, not picked: shorter than one live check's own deadline, so a
  // rung that waited on a slow Google check always re-reads, and well inside the
  // confirm's budget, so a walk that re-reads still has the budget to book.
  assert(LADDER_READ_MAX_AGE_MS * 4 <= GOOGLE_CONFIRM_TIMEOUT_MS, `the bound (${LADDER_READ_MAX_AGE_MS}ms) is at most a quarter of one live check's deadline (${GOOGLE_CONFIRM_TIMEOUT_MS}ms)`);
  assert(LADDER_READ_MAX_AGE_MS * 6 <= BOOKING_CONFIRM_BUDGET_MS, `the bound (${LADDER_READ_MAX_AGE_MS}ms) is at most a sixth of the confirm budget (${BOOKING_CONFIRM_BUDGET_MS}ms)`);

  // Control (L1): a quick walk is judged entirely from its one read, and that read still
  // holds `b`, so the stale read WOULD offer the advisor who has since become unbookable.
  // Without this the test below could pass on a walk that never offered `b` at all.
  const quick = await walk(LADDER_READ_MAX_AGE_MS - 500);
  assert(quick.reads === 1, `a walk inside the bound reads the ladder once (reads: ${quick.reads})`);
  assert(quick.judgedBy["311"] !== undefined && Object.values(quick.judgedBy).flat().every((l) => l === "first"), `a walk inside the bound judges the lower rung from its one read (got ${JSON.stringify(quick.judgedBy)})`);
  assert(quick.booking?.assigned_user_id === "b", `control: the one read offers b, the first free advisor on the rung below (got ${quick.booking?.assigned_user_id})`);

  // The walk outlives its read: the lower rung is judged from a fresh one, which no
  // longer holds b, so the lead is booked with c and never with b.
  const slow = await walk(LADDER_READ_MAX_AGE_MS + 500);
  assert(slow.reads === 2, `a walk that outlived its read reads the ladder again, once (reads: ${slow.reads})`);
  assert(slow.judgedBy["411"] === undefined, `the requested rung was judged before the clock moved, from the first read (got ${JSON.stringify(slow.judgedBy)})`);
  assert(
    slow.judgedBy["311"] !== undefined && Object.values(slow.judgedBy).flat().every((l) => l === "second"),
    `every rung judged after the live check is judged from the fresh read, never the stale one (got ${JSON.stringify(slow.judgedBy)})`,
  );
  assert(slow.booking?.assigned_user_id === "c", `the advisor who became unbookable during the walk is never offered: booked with c (got ${slow.booking?.assigned_user_id}, ${slow.error instanceof Error ? slow.error.message : ""})`);

  // A slow FIRST read is not a stale one: the bound is about time the walk spends after
  // the read answered, so a read that itself took longer than the bound (a slow
  // database, when another read is least wanted) is used, never thrown away at once.
  const slowRead = await walk(0, undefined, LADDER_READ_MAX_AGE_MS + 500);
  assert(slowRead.reads === 1, `a first read that was slow to answer is not re-made before the walk spends any time (reads: ${slowRead.reads})`);
  assert(slowRead.booking !== null, `the walk books from that read (got ${slowRead.error instanceof Error ? slowRead.error.message : "nothing"})`);

  // Failure path: the fresh read fails. The walk must not fall back to the stale read
  // (that is the exposure itself), so the confirm fails as a failed first read does,
  // with nothing booked.
  const failed = await walk(LADDER_READ_MAX_AGE_MS + 500, async () => {
    throw new Error("ladder candidate inputs: connection reset");
  });
  assert(failed.reads === 2, `the failed re-read was attempted (reads: ${failed.reads})`);
  assert(failed.booking === null, `a failed re-read books nobody (got ${failed.booking?.assigned_user_id})`);
  assert(failed.error instanceof Error && /connection reset/.test(failed.error.message), `a failed re-read fails the confirm with its own error, never a stale answer (got ${failed.error instanceof Error ? failed.error.message : String(failed.error)})`);
  assert(Object.keys(failed.judgedBy).length === 0, `nothing is judged from the stale read once it has failed to refresh (got ${JSON.stringify(failed.judgedBy)})`);
}

main()
  .finally(() => {
    Date.now = realNow;
  })
  .then(finish);
