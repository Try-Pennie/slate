import { describe, it, expect, vi, beforeEach } from "vitest";

// #3360: a Google edit shortened an approved time off, the busy block followed it,
// and a lead was booked into the hours the edit opened. Slate now holds the approved
// window whatever the event says, and THIS is what tells a person the two disagree:
// the calendar sync pages the moment it sees the edit, and the monitor lane
// re-measures every approved future request, pages anything the sync could not see,
// and is the only place the all-clear is decided, off a measured healthy read.
const recordConsecutiveStreak = vi.hoisted(() =>
  vi.fn(async (_key: string, _windowSeconds: number, _afterTicks: number) => true),
);
const clearFailureStreak = vi.hoisted(() => vi.fn(async (_key: string) => {}));
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _body: string) => {}),
);
const resolveAlert = vi.hoisted(() => vi.fn(async (_key: string, _text: string) => true));
const firingFamilyMembers = vi.hoisted(() => vi.fn(async (_family: string): Promise<string[]> => []));

vi.mock("@/lib/notify/streak", () => ({ recordConsecutiveStreak, clearFailureStreak }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, resolveAlert, firingFamilyMembers }));

import {
  eventMismatchesByAgent,
  isTimeOffEventIdShape,
  noticeSyncedOooEvents,
  oooEventMismatchKey,
  runOooEventMismatchCheck,
  OOO_EVENT_MISMATCH_ALERT_AFTER_TICKS,
  OOO_EVENT_MISMATCH_FAMILY,
  type ApprovedEventRequest,
  type EventMirror,
} from "./ooo-event-mismatch";
import { oooEventMismatchAlert, oooEventMismatchRecovery } from "@/lib/ooo/alert-copy";
import { deterministicEventId, freshEventId, TOMBSTONE_FRESH_IDS } from "@/lib/booking/core";

const NOW = Date.parse("2026-10-06T09:00:00.000Z");
const APP = "https://slate.example.com";

// The real shape from 2026-10-06: all of Wednesday in MT, the event moved to 11:30 AM.
const request = (over: Partial<ApprovedEventRequest> = {}): ApprovedEventRequest => ({
  id: "13137fb6",
  userId: "u-heather",
  agentName: "Heather McLellen",
  agentEmail: "heather@trypennie.com",
  startsAt: "2026-10-07T06:00:00.000Z",
  endsAt: "2026-10-08T05:59:00.000Z",
  displayTzId: "America/Denver",
  displayTzLabel: "MT",
  agentEventId: "evt-ooo",
  inPool: true,
  ...over,
});
const mirror = (over: Partial<EventMirror> = {}): EventMirror => ({
  userId: "u-heather",
  gcalEventId: "evt-ooo",
  startsAt: "2026-10-07T17:30:00.000Z",
  endsAt: "2026-10-08T05:59:00.000Z",
  ...over,
});
const matching = () => mirror({ startsAt: "2026-10-07T06:00:00.000Z" });

beforeEach(() => {
  vi.clearAllMocks();
  recordConsecutiveStreak.mockImplementation(async () => true);
  firingFamilyMembers.mockImplementation(async () => []);
});

describe("eventMismatchesByAgent", () => {
  it("finds the measured case: the event leaves the head of the approved day open", () => {
    const found = eventMismatchesByAgent([request()], [mirror()], NOW);
    expect([...found.keys()]).toEqual(["u-heather"]);
    const f = found.get("u-heather")!.found[0]!;
    expect(f.requestId).toBe("13137fb6");
    expect(f.coverage.kind).toBe("uncovered");
  });

  it("finds nothing when the event matches the request", () => {
    expect(eventMismatchesByAgent([request()], [matching()], NOW).size).toBe(0);
  });

  it("reads a missing mirror as the calendar blocking nothing, never as agreement", () => {
    const f = eventMismatchesByAgent([request()], [], NOW).get("u-heather")!.found[0]!;
    expect(f.coverage.kind).toBe("not-blocking");
  });

  it("ignores another agent's row that happens to carry the same event id", () => {
    const found = eventMismatchesByAgent([request()], [matching(), mirror({ userId: "u-other" })], NOW);
    expect(found.size).toBe(0);
  });

  it("skips a request with no calendar event: that is the fallback page's job", () => {
    expect(eventMismatchesByAgent([request({ agentEventId: null })], [], NOW).size).toBe(0);
  });

  it("skips an agent out of the pool, whose calendar is not synced at all", () => {
    expect(eventMismatchesByAgent([request({ inPool: false })], [], NOW).size).toBe(0);
  });
});

describe("runOooEventMismatchCheck", () => {
  const run = (load: () => Promise<{ requests: ApprovedEventRequest[]; mirrors: EventMirror[] }>) =>
    runOooEventMismatchCheck({
      load,
      loadAgentNames: async (ids) => new Map(ids.map((id) => [id, `name of ${id}`])),
      nowMs: NOW,
      appBaseUrl: APP,
    });

  it("pages per agent once the disagreement is sustained", async () => {
    const res = await run(async () => ({ requests: [request()], mirrors: [mirror()] }));
    expect(recordConsecutiveStreak).toHaveBeenCalledWith(
      oooEventMismatchKey("u-heather"),
      expect.any(Number),
      OOO_EVENT_MISMATCH_ALERT_AFTER_TICKS,
    );
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(sendThrottledAlert.mock.calls[0]![0]).toBe(`${OOO_EVENT_MISMATCH_FAMILY}:u-heather`);
    expect(res).toMatchObject({ status: "mismatched", mismatchedAgents: 1, reachedVerdict: true });
  });

  it("stays quiet on the first tick, so Slate's own cancel in flight never pages", async () => {
    recordConsecutiveStreak.mockImplementation(async () => false);
    await run(async () => ({ requests: [request()], mirrors: [] }));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("clears a firing agent off a MEASURED agreement, naming the agent", async () => {
    firingFamilyMembers.mockImplementation(async () => ["u-heather"]);
    const res = await run(async () => ({ requests: [request()], mirrors: [matching()] }));
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    expect(resolveAlert.mock.calls[0]![0]).toBe(oooEventMismatchKey("u-heather"));
    expect(resolveAlert.mock.calls[0]![1]).toContain("Heather McLellen");
    expect(clearFailureStreak).toHaveBeenCalledWith(oooEventMismatchKey("u-heather"));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(res.cleared).toBe(1);
  });

  it("clears an agent with nothing approved ahead any more, looking the name up", async () => {
    // The request was changed back to pending, cancelled, or its window passed: it is
    // no longer in the approved future set, so nothing approved can disagree.
    firingFamilyMembers.mockImplementation(async () => ["u-gone"]);
    await run(async () => ({ requests: [], mirrors: [] }));
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    expect(resolveAlert.mock.calls[0]![1]).toContain("name of u-gone");
  });

  it("never clears an agent whose event could not be read: nothing was compared", async () => {
    // An unreadable stamp is "could not tell", not agreement (L11, #1152). Without
    // this, a firing agent drops out of the found set and is sent an all-clear off a
    // comparison that never happened.
    firingFamilyMembers.mockImplementation(async () => ["u-heather"]);
    const res = await run(async () => ({
      requests: [request()],
      mirrors: [mirror({ startsAt: "not a timestamp" })],
    }));
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(res.cleared).toBe(0);
  });

  it("never clears an agent whose only request ahead is out of the pool: nothing was compared", async () => {
    // Skipped is "not compared", exactly like unreadable (L11). The page stands until
    // the request leaves the approved set, which is then a measured "nothing ahead".
    firingFamilyMembers.mockImplementation(async () => ["u-heather"]);
    const res = await run(async () => ({ requests: [request({ inPool: false })], mirrors: [] }));
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(res.cleared).toBe(0);
  });

  it("never clears an agent whose only request ahead has no calendar event to compare", async () => {
    firingFamilyMembers.mockImplementation(async () => ["u-heather"]);
    const res = await run(async () => ({ requests: [request({ agentEventId: null })], mirrors: [] }));
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(res.cleared).toBe(0);
  });

  it("never clears an agent beside an uncompared request, even when the compared one agrees", async () => {
    // The page names request ids the lane does not remember, so the one it could not
    // compare may be the one it paged about.
    firingFamilyMembers.mockImplementation(async () => ["u-heather"]);
    const res = await run(async () => ({
      requests: [request(), request({ id: "r-imported", agentEventId: null })],
      mirrors: [matching()],
    }));
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(res.cleared).toBe(0);
  });

  it("the all-clear after a comparison says how many windows were compared and agree", async () => {
    firingFamilyMembers.mockImplementation(async () => ["u-heather"]);
    await run(async () => ({
      requests: [request(), request({ id: "r2", agentEventId: "evt-2" })],
      mirrors: [matching(), mirror({ gcalEventId: "evt-2", startsAt: request().startsAt })],
    }));
    expect(resolveAlert.mock.calls[0]![1]).toBe(
      oooEventMismatchRecovery("Heather McLellen", { kind: "agreed", compared: 2 }),
    );
  });

  it("the all-clear with nothing approved ahead claims no comparison at all", async () => {
    firingFamilyMembers.mockImplementation(async () => ["u-gone"]);
    await run(async () => ({ requests: [], mirrors: [] }));
    expect(resolveAlert.mock.calls[0]![1]).toBe(
      oooEventMismatchRecovery("name of u-gone", { kind: "nothing-ahead" }),
    );
  });

  it("still clears an agent once every one of their windows reads and agrees", async () => {
    // The control for the case above: the same agent with a readable, matching event
    // is cleared, so the refusal above is about the unreadable stamp, nothing else.
    firingFamilyMembers.mockImplementation(async () => ["u-heather"]);
    const res = await run(async () => ({ requests: [request()], mirrors: [matching()] }));
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    expect(res.cleared).toBe(1);
  });

  it("never clears an agent who still disagrees", async () => {
    firingFamilyMembers.mockImplementation(async () => ["u-heather"]);
    await run(async () => ({ requests: [request()], mirrors: [mirror()] }));
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("does neither on a failed read: an unread list is not a healthy one", async () => {
    firingFamilyMembers.mockImplementation(async () => ["u-heather"]);
    const res = await run(async () => {
      throw new Error("PostgREST 500");
    });
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "unreadable", reachedVerdict: false });
  });

  it("still pages when the firing markers cannot be read, and clears nothing", async () => {
    firingFamilyMembers.mockImplementation(async () => {
      throw new Error("alert_state unreadable");
    });
    await run(async () => ({ requests: [request(), request({ id: "r2", userId: "u2", agentEventId: "e2" })], mirrors: [mirror(), mirror({ userId: "u2", gcalEventId: "e2", startsAt: request().startsAt })] }));
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(resolveAlert).not.toHaveBeenCalled();
  });
});

describe("noticeSyncedOooEvents (the page at the moment the sync sees the edit)", () => {
  // The shape Slate mints for every agent time off event (#1469, #3217).
  const OOO_ID = `slate${"a1".repeat(32)}`;
  const event = (over: Record<string, unknown> = {}) => ({
    id: OOO_ID,
    status: "confirmed",
    start: { dateTime: "2026-10-07T11:30:00-06:00" },
    end: { dateTime: "2026-10-07T23:59:00-06:00" },
    ...over,
  });
  const deps = (over: Partial<Parameters<typeof noticeSyncedOooEvents>[0]> = {}) => ({
    userId: "u-heather",
    events: [event()],
    timeZone: "America/Denver",
    nowMs: NOW,
    appBaseUrl: APP,
    bookingEventIds: new Set<string>(),
    loadApproved: vi.fn(async () => [request({ agentEventId: OOO_ID })]),
    loadAgentName: vi.fn(async () => "Heather McLellen"),
    ...over,
  });

  it("pages at once, with no streak, when an approved request's event is shortened", async () => {
    const d = deps();
    const paged = await noticeSyncedOooEvents(d);
    expect(paged).toBe(1);
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(sendThrottledAlert.mock.calls[0]![0]).toBe(oooEventMismatchKey("u-heather"));
    expect(sendThrottledAlert.mock.calls[0]![2]).toContain("13137fb6");
  });

  it("stays quiet when the event still covers the approved window", async () => {
    const d = deps({ events: [event({ start: { dateTime: "2026-10-07T00:00:00-06:00" } })] });
    expect(await noticeSyncedOooEvents(d)).toBe(0);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("leaves a CANCELLED event to the monitor lane, because Slate's own cancel deletes it first", async () => {
    const d = deps({ events: [event({ status: "cancelled" })] });
    expect(await noticeSyncedOooEvents(d)).toBe(0);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("ignores events that belong to no approved time off", async () => {
    const d = deps({ events: [event({ id: `slate${"b2".repeat(32)}` })] });
    expect(await noticeSyncedOooEvents(d)).toBe(0);
    expect(d.loadAgentName).not.toHaveBeenCalled();
  });

  it("reads nothing when no event in the pass could be a time off event", async () => {
    // The agent's own meetings (Google minted ids), a Slate booking the sync already
    // knows, and a cancelled Slate event: none can be a SHORTENED time off, so the
    // pass spends no subrequest on the budget four cron lanes share.
    const booking = `slate${"c3".repeat(32)}`;
    const d = deps({
      events: [
        event({ id: "4k2j9h1abc0def" }),
        event({ id: booking }),
        event({ status: "cancelled" }),
      ],
      bookingEventIds: new Set([booking]),
    });
    expect(await noticeSyncedOooEvents(d)).toBe(0);
    expect(d.loadApproved).not.toHaveBeenCalled();
  });

  it("reads exactly once when one event could be a time off event", async () => {
    const d = deps({ events: [event({ id: "4k2j9h1abc0def" }), event()] });
    expect(await noticeSyncedOooEvents(d)).toBe(1);
    expect(d.loadApproved).toHaveBeenCalledTimes(1);
  });

  it("still reads for a time off event on a fresh id past a tombstone", async () => {
    const fresh = freshEventId(OOO_ID, 2);
    const d = deps({
      events: [event({ id: fresh })],
      loadApproved: vi.fn(async () => [request({ agentEventId: fresh })]),
    });
    expect(await noticeSyncedOooEvents(d)).toBe(1);
    expect(d.loadApproved).toHaveBeenCalledTimes(1);
  });

  it("reads nothing at all for an empty batch", async () => {
    const d = deps({ events: [] });
    await noticeSyncedOooEvents(d);
    expect(d.loadApproved).not.toHaveBeenCalled();
  });
});

describe("isTimeOffEventIdShape", () => {
  it("accepts every id Slate can mint for a time off event", async () => {
    // Derived from the minting functions themselves, so a change to either fails here
    // rather than silently skipping the read for every real event.
    const minted = await deterministicEventId("ooo-agent:13137fb6", "u-heather");
    expect(isTimeOffEventIdShape(minted)).toBe(true);
    for (let n = 1; n <= TOMBSTONE_FRESH_IDS; n++) {
      expect(isTimeOffEventIdShape(freshEventId(minted, n))).toBe(true);
    }
  });

  it("refuses an id Google minted itself", () => {
    expect(isTimeOffEventIdShape("4k2j9h1abc0def")).toBe(false);
    expect(isTimeOffEventIdShape("slate")).toBe(false);
    expect(isTimeOffEventIdShape(`slate${"a1".repeat(32)}_20261007T060000Z`)).toBe(false);
  });
});

describe("the copy", () => {
  const text = oooEventMismatchAlert(
    "Heather McLellen",
    [
      {
        requestId: "13137fb6",
        startsAt: request().startsAt,
        endsAt: request().endsAt,
        displayTzId: "America/Denver",
        displayTzLabel: "MT",
        coverage: {
          kind: "uncovered",
          spans: [
            {
              startMs: Date.parse("2026-10-07T06:00:00.000Z"),
              endMs: Date.parse("2026-10-07T17:30:00.000Z"),
            },
          ],
        },
      },
    ],
    APP,
  );

  it("names the request, the approved window and the open span in the agent's zone", () => {
    expect(text).toContain(`${APP}/admin/ooo?request=13137fb6`);
    expect(text).toContain("Heather McLellen");
    expect(text).toContain("11:30am");
    expect(text).toContain("MT");
  });

  it("asks for the two to be made to agree EITHER way, never that the event is wrong", () => {
    // On 2026-10-06 the Google edit was the true one: the agent was working.
    expect(text).toContain("change the request in My time off");
    expect(text).toContain("put the calendar event back");
    expect(text.toLowerCase()).not.toContain("undo");
  });

  it("says the approved window is still blocked, so nobody rushes to protect it", () => {
    expect(text).toContain("still blocking the whole approved window");
  });

  it("does not open with Slate, which Slack already shows as the sender", () => {
    expect(text.startsWith("Slate")).toBe(false);
  });

  it("the all-clear after a comparison names the agent and the count compared", () => {
    const r = oooEventMismatchRecovery("Heather McLellen", { kind: "agreed", compared: 2 });
    expect(r).toContain("Heather McLellen");
    expect(r).toContain("2 approved windows");
    expect(r).toContain("No action is needed");
    const one = oooEventMismatchRecovery("Heather McLellen", { kind: "agreed", compared: 1 });
    expect(one).toContain("the one approved window");
  });

  it("the all-clear with nothing ahead never claims a comparison (L11, L440)", () => {
    const r = oooEventMismatchRecovery("Heather McLellen", { kind: "nothing-ahead" });
    expect(r).toContain("Heather McLellen");
    expect(r).toContain("no approved time off still ahead");
    expect(r.toLowerCase()).not.toContain("match");
    expect(r.toLowerCase()).not.toContain("compared");
  });
});
