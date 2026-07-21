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
    },
  );
  assert(r.assignment?.userId === "b", "the out agent is excluded; the first free other agent wins");
  assert(!v.calls()[0].emails.includes("a@x.com"), "the out agent is never verify-checked");

  // verifyFree is asked about the booking's EXACT original window (start .. +duration).
  assert(
    v.calls()[0].startIso === "2026-06-08T13:00:00.000Z" && v.calls()[0].endIso === "2026-06-08T13:30:00.000Z",
    "live freeness is checked over the booking's exact original 30-minute window",
  );

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
    },
  );
  assert(r.assignment === null, "no free eligible agent yields an unplaceable (null) target");
}

await run();
finish();
