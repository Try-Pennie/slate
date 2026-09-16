import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #2412: what a lead actually gets when Google reports a per calendar failure
// inside its 200 reply on the LAST check before `createEvent`.
//
// The bulk cross identity wave refuses to trust a calendar carrying `errors[]`
// and hands that agent to the direct per agent check, which the code calls "the
// accurate fallback". That fallback impersonates the agent and asks the SAME
// calendar, so it meets the SAME error. Until this change it read the reply for
// `busy` alone, found none, and answered FREE, and the lead was booked over
// whatever the calendar held.
//
// Everything below the Supabase read and the Google HTTP call is the real
// shipped code: the real `freeBusy` parser and the real `checkAgentFree`
// mapping, reached through `verifyAgentsDirectly` and `agentBusyIntervals`,
// which is how `realDeps` wires both halves into the booker.
//
// What the BOOKER then does with an `unverified` verdict is
// `scripts/test-verify-on-book-unverified.ts`: it drives the real orchestration
// through the shared booking fake, which lives in `scripts/` and so cannot be
// imported from here without pulling that tree into the app's `tsc` program.

const dwd = vi.hoisted(() => ({ getDelegatedToken: vi.fn() }));
vi.mock("@/lib/google/dwd", () => dwd);

// The agent resolves to one user holding one synced calendar. Both reads
// SUCCEED, which is the point: `readFailed` stays false, so nothing about
// Slate's own database is wrong here and the only fault is Google's per calendar
// error inside its 200.
const AGENT = "agent@trypennie.com";
const admin = vi.hoisted(() => {
  const agentEmail = "agent@trypennie.com";
  const client = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { id: "u-1" }, error: null }),
          then: (resolve: (r: unknown) => unknown) =>
            resolve(
              table === "agent_calendars"
                ? { data: [{ calendar_id: agentEmail }], error: null }
                : { data: [], error: null },
            ),
        }),
      }),
    }),
  };
  return { supabaseAdmin: vi.fn(() => client) };
});
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: admin.supabaseAdmin }));

import { verifyAgentsDirectly, agentBusyIntervals } from "./service";

const START = "2026-06-08T15:00:00.000Z";
const END = "2026-06-08T15:30:00.000Z";

/** One canned freeBusy reply for every call in the run. */
function answerFreeBusyWith(payload: unknown) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload), { status: 200 }));
}

const ERRORED = { calendars: { [AGENT]: { errors: [{ reason: "internalError" }] } } };
const NOT_FOUND = { calendars: { [AGENT]: { errors: [{ reason: "notFound" }] } } };
const ABSENT = { calendars: {} };
const CLEAN = { calendars: { [AGENT]: { busy: [] } } };

describe("the per agent fallback never reads an unreadable calendar as free (#2412)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  it("reports the agent unverified when their calendar carries an error", async () => {
    answerFreeBusyWith(ERRORED);

    const res = await verifyAgentsDirectly([AGENT], START, END);

    expect([...res.unverified]).toEqual([AGENT]);
    expect([...res.free]).toEqual([]);
  });

  it("reports the agent unverified when Google says notFound", async () => {
    answerFreeBusyWith(NOT_FOUND);

    const res = await verifyAgentsDirectly([AGENT], START, END);

    expect([...res.unverified]).toEqual([AGENT]);
    expect([...res.free]).toEqual([]);
  });

  it("reports the agent unverified when the calendar is absent from the reply", async () => {
    answerFreeBusyWith(ABSENT);

    const res = await verifyAgentsDirectly([AGENT], START, END);

    expect([...res.unverified]).toEqual([AGENT]);
    expect([...res.free]).toEqual([]);
  });

  // The control that stops the fix from making every agent unbookable.
  it("still reports the agent FREE on a clean empty calendar", async () => {
    answerFreeBusyWith(CLEAN);

    const res = await verifyAgentsDirectly([AGENT], START, END);

    expect([...res.free]).toEqual([AGENT]);
    expect([...res.unverified]).toEqual([]);
  });

  it("still reports the agent neither free nor unverified when genuinely busy", async () => {
    answerFreeBusyWith({
      calendars: { [AGENT]: { busy: [{ start: START, end: END }] } },
    });

    const res = await verifyAgentsDirectly([AGENT], START, END);

    expect([...res.free]).toEqual([]);
    expect([...res.unverified]).toEqual([]);
  });
});

// The in place reschedule guard reads the same reply through the same reader, so
// it has to reach the same verdict. `null` is what the guard already re-routes
// on: `inPlaceDeclineReason = "calendar"`, which sends the booking back through
// routing rather than leaving the agent on a slot nothing verified.
describe("the reschedule guard reads an unreadable calendar the same way (#2412)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  it("could not tell when the calendar carries an error", async () => {
    answerFreeBusyWith(ERRORED);
    expect(await agentBusyIntervals(AGENT, START, END)).toBeNull();
  });

  it("could not tell when the calendar is absent from the reply", async () => {
    answerFreeBusyWith(ABSENT);
    expect(await agentBusyIntervals(AGENT, START, END)).toBeNull();
  });

  it("still reports NO busy time for a clean empty calendar", async () => {
    answerFreeBusyWith(CLEAN);
    expect(await agentBusyIntervals(AGENT, START, END)).toEqual([]);
  });

  it("still reports a real busy period", async () => {
    answerFreeBusyWith({
      calendars: { [AGENT]: { busy: [{ start: START, end: END }] } },
    });
    expect(await agentBusyIntervals(AGENT, START, END)).toEqual([
      { start: Date.parse(START), end: Date.parse(END) },
    ]);
  });
});
