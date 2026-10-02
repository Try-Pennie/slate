// Test for the coverage-reassign target wiring (#972): selectCoverageReassignTarget
// composes the ordered eligible list + LIVE verify-on-book + LIVE daily-cap check
// and excludes the out agent, so the bulk engine (#973) can call one function to
// find a genuinely-free, under-cap covering agent (or null when unplaceable).
// The reassign swap rides allow_double_book, so freeness MUST be the live path
// (verifyFree over the booking's exact original window), never the busy_blocks
// cache. Pure-with-fakes → node harness (no module mocking).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coverage-target.ts
import { selectCoverageReassignTarget } from "../src/lib/booking/coverage-target.ts";
import type { EventType } from "../src/lib/db/types.ts";
import { bucket, eventType, makeBooking } from "./lib/booking-fakes.ts";
import { assert, finish } from "./lib/harness.ts";

// Nobody on approved time off: the baseline for every case that is not about the
// #1236 filter. Required rather than optional, so a new call site cannot forget to
// answer "is this agent actually away" and silently fall back to Google alone.
const noneOnTimeOff = async () => new Set<string>();

const emailOf: Record<string, string> = { a: "a@x.com", b: "b@x.com", c: "c@x.com" };
const loadEmails = async (ids: string[]) => {
  const m = new Map<string, string>();
  for (const id of ids) if (emailOf[id]) m.set(id, emailOf[id]);
  return m;
};

// verifyFree fake: records the window it was asked about; frees the given emails.
function verifier(free: Set<string>) {
  const calls: { emails: string[]; startIso: string; endIso: string }[] = [];
  return {
    fn: async (emails: string[], startIso: string, endIso: string) => {
      calls.push({ emails, startIso, endIso });
      return { free: new Set(emails.filter((e) => free.has(e))), unverified: new Set<string>() };
    },
    calls: () => calls,
  };
}

// Working-hours + per-day booking-count fakes for the cap closure. `startsByUser`
// maps a userId to the epoch-ms starts the cap check should see for that day.
function capDeps(startsByUser: Record<string, number[]> = {}) {
  const whCalls: string[] = [];
  const countCalls: { userId: string; fromIso: string; toIso: string; exclude: string }[] = [];
  return {
    agentWorkingHours: async (userId: string) => {
      whCalls.push(userId);
      return { timezone: "America/New_York", rules: [] };
    },
    agentActiveBookingStartsMs: async (userId: string, fromIso: string, toIso: string, exclude: string) => {
      countCalls.push({ userId, fromIso, toIso, exclude });
      return startsByUser[userId] ?? [];
    },
    whCalls: () => whCalls,
    countCalls: () => countCalls,
  };
}

async function run() {
  // The out agent (assigned_user_id "a") is excluded; first free other agent wins.
  const booking = makeBooking({ id: "bk-out", assigned_user_id: "a", starts_at: "2026-06-08T13:00:00.000Z" });
  let v = verifier(new Set(["a@x.com", "b@x.com", "c@x.com"]));
  let cap = capDeps();
  let r = await selectCoverageReassignTarget(
    { booking, bucket, eventType },
    {
      orderedEligibleIds: async () => ["a", "b", "c"],
      loadEmails,
      verifyFree: v.fn,
      agentWorkingHours: cap.agentWorkingHours,
      agentActiveBookingStartsMs: cap.agentActiveBookingStartsMs,
      userIdsOnApprovedTimeOff: noneOnTimeOff,
    },
  );
  assert(r.assignment?.userId === "b", "the out agent is excluded; the first free other agent wins");
  assert(!v.calls()[0].emails.includes("a@x.com"), "the out agent is never verify-checked");

  // verifyFree is asked about the booking's EXACT original window (start .. +duration).
  assert(
    v.calls()[0].startIso === "2026-06-08T13:00:00.000Z" && v.calls()[0].endIso === "2026-06-08T13:30:00.000Z",
    "live freeness is checked over the booking's exact original 30-minute window",
  );

  // With a buffer between calls, the live check covers the buffer too, so a
  // moved booking cannot land back to back with the new advisor's next meeting.
  {
    const buffered = { ...eventType, buffer_before_min: 10, buffer_after_min: 10 } as unknown as EventType;
    const bv = verifier(new Set(["b@x.com"]));
    const bcap = capDeps();
    await selectCoverageReassignTarget(
      { booking, bucket, eventType: buffered },
      {
        orderedEligibleIds: async () => ["a", "b"],
        loadEmails,
        verifyFree: bv.fn,
        agentWorkingHours: bcap.agentWorkingHours,
        agentActiveBookingStartsMs: bcap.agentActiveBookingStartsMs,
        userIdsOnApprovedTimeOff: noneOnTimeOff,
      },
    );
    assert(
      bv.calls()[0]?.startIso === "2026-06-08T12:50:00.000Z" && bv.calls()[0]?.endIso === "2026-06-08T13:40:00.000Z",
      `live freeness covers the buffer either side of the call (got ${JSON.stringify(bv.calls()[0])})`,
    );
  }

  // An uncapped event type does NO cap reads (working-hours / day-count untouched).
  assert(
    cap.whCalls().length === 0 && cap.countCalls().length === 0,
    "an uncapped event type performs no daily-cap reads",
  );

  // A capped event type: the first free agent is over cap, so the next free
  // under-cap agent wins, with the cap keyed to the booking's LOCAL day.
  const capped = { ...eventType, daily_cap: 2 } as unknown as EventType;
  v = verifier(new Set(["b@x.com", "c@x.com"]));
  // Agent b already has 2 bookings on the booking's local day (2026-06-08 ET) → at
  // cap; agent c has none. The starts MUST fall on that local day to count.
  cap = capDeps({ b: [Date.parse("2026-06-08T14:00:00.000Z"), Date.parse("2026-06-08T15:00:00.000Z")] });
  r = await selectCoverageReassignTarget(
    { booking, bucket, eventType: capped },
    {
      orderedEligibleIds: async () => ["a", "b", "c"],
      loadEmails,
      verifyFree: v.fn,
      agentWorkingHours: cap.agentWorkingHours,
      agentActiveBookingStartsMs: cap.agentActiveBookingStartsMs,
      userIdsOnApprovedTimeOff: noneOnTimeOff,
    },
  );
  assert(r.assignment?.userId === "c", "a free-but-at-cap agent is passed over for a free under-cap one");
  assert(
    cap.countCalls().every((c) => c.exclude === "bk-out"),
    "the cap day-count excludes the booking being moved",
  );
  // The cap window is the booking's local ET day (2026-06-08), not UTC midnight.
  assert(
    cap.countCalls()[0].fromIso.startsWith("2026-06-08T00:00:00.000-04:00"),
    "the cap day-count window is anchored on the booking's local (ET) day start",
  );

  // Unplaceable: no eligible agent is free at the original time → null target.
  v = verifier(new Set());
  cap = capDeps();
  r = await selectCoverageReassignTarget(
    { booking, bucket, eventType },
    {
      orderedEligibleIds: async () => ["b", "c"],
      loadEmails,
      verifyFree: v.fn,
      agentWorkingHours: cap.agentWorkingHours,
      agentActiveBookingStartsMs: cap.agentActiveBookingStartsMs,
      userIdsOnApprovedTimeOff: noneOnTimeOff,
    },
  );
  assert(r.assignment === null, "no free eligible agent yields an unplaceable (null) target");

  // --- #1236: a candidate on approved time off is never a coverage target -----
  //
  // Freeness here is LIVE Google only, and it never reads busy_blocks (see the
  // header). That is correct for a churning cache, but it means an agent on
  // approved time off is excluded ONLY because runPostApproval put an event on
  // their Google calendar. That write is best-effort: when it fails, the OOO flow
  // falls back to a slate-source busy_block, which availability can see and this
  // selection cannot. So two agents off the same week plus one failed Google
  // write placed every booking swept off the first onto the second, who was also
  // away: #1219 recreated by the fix for #1219. `ooo_requests` is authoritative
  // because it does not depend on Google having accepted anything.
  const awayDeps = (
    onTimeOff: (ids: string[]) => Promise<Set<string>>,
    ordered: string[] = ["b", "c"],
  ) => {
    v = verifier(new Set(["a@x.com", "b@x.com", "c@x.com"])); // Google says everyone is free
    cap = capDeps();
    return {
      orderedEligibleIds: async () => ordered,
      loadEmails,
      verifyFree: v.fn,
      agentWorkingHours: cap.agentWorkingHours,
      agentActiveBookingStartsMs: cap.agentActiveBookingStartsMs,
      userIdsOnApprovedTimeOff: onTimeOff,
    };
  };

  const timeOffCalls: { ids: string[]; startIso: string; endIso: string }[] = [];
  r = await selectCoverageReassignTarget({ booking, bucket, eventType }, {
    ...awayDeps(async () => new Set(["b"])),
    userIdsOnApprovedTimeOff: async (ids: string[], startIso: string, endIso: string) => {
      timeOffCalls.push({ ids, startIso, endIso });
      return new Set(["b"]);
    },
  });
  assert(
    r.assignment?.userId === "c",
    "an agent on approved time off is skipped even when Google reports them free",
  );
  assert(
    timeOffCalls[0]?.startIso === "2026-06-08T13:00:00.000Z",
    "the time-off check is asked about the booking's own window, not the coverage range",
  );

  // An agent whose approved time off does NOT overlap stays selectable, so the
  // filter cannot quietly shrink the pool for everyone with any time off booked.
  r = await selectCoverageReassignTarget(
    { booking, bucket, eventType },
    awayDeps(async () => new Set()),
  );
  assert(
    r.assignment?.userId === "b",
    "an agent with no overlapping time off is still selected first",
  );

  // The failure path, and the reason it is `unverified` rather than unplaceable:
  // an unplaceable item is TERMINAL (bulk-reassign.ts), so a transient read error
  // must never land there or one database hiccup strands the booking for good.
  // Reporting it as unverified reuses the outage semantics the engine already has,
  // which retries the item and only then settles it as `failed` (actionable).
  // It must also never fall through to a placement: the whole point is that we
  // cannot tell whether these agents are away.
  r = await selectCoverageReassignTarget(
    { booking, bucket, eventType },
    awayDeps(async () => {
      throw new Error("ooo read failed");
    }),
  );
  assert(
    r.assignment === null,
    "a failed time-off read never places the booking (fails closed, not open)",
  );
  assert(
    r.anyUnverified === true,
    "a failed time-off read reports unverified, so the item retries instead of settling unplaceable",
  );
}

await run();
finish();
