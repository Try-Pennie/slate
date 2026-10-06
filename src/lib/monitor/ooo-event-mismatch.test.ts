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
  noticeSyncedOooEvents,
  oooEventMismatchKey,
  runOooEventMismatchCheck,
  OOO_EVENT_MISMATCH_ALERT_AFTER_TICKS,
  OOO_EVENT_MISMATCH_FAMILY,
  type ApprovedEventRequest,
  type EventMirror,
} from "./ooo-event-mismatch";
import { oooEventMismatchAlert, oooEventMismatchRecovery } from "@/lib/ooo/alert-copy";

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
  const event = (over: Record<string, unknown> = {}) => ({
    id: "evt-ooo",
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
    loadApproved: vi.fn(async () => [request()]),
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
    const d = deps({ events: [event({ id: "a-meeting" })] });
    expect(await noticeSyncedOooEvents(d)).toBe(0);
    expect(d.loadAgentName).not.toHaveBeenCalled();
  });

  it("reads nothing at all for an empty batch", async () => {
    const d = deps({ events: [] });
    await noticeSyncedOooEvents(d);
    expect(d.loadApproved).not.toHaveBeenCalled();
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

  it("the all-clear names the agent and claims only what was measured", () => {
    const r = oooEventMismatchRecovery("Heather McLellen");
    expect(r).toContain("Heather McLellen");
    expect(r).toContain("No action is needed");
  });
});
