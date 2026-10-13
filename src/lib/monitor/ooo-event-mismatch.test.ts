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
  mirroredHorizonMs,
  primaryMirroredHorizons,
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
import { BUSY_WINDOW_AHEAD_DAYS } from "@/lib/google/sync-coalesce";

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
  // The primary calendar's mirrored horizon, NOW plus the 21 day write window, as a
  // calendar hydrated this morning carries it (#3655).
  mirroredUntil: "2026-10-27T09:00:00.000Z",
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

describe("the calendar's mirrored horizon (#3655)", () => {
  // On 2026-10-12 three approved requests 24 to 69 days out paged as "no busy time
  // off event", and `verify:ooo-protection` read all three intact in Google. The
  // sync deletes the mirror of an event that changes while it starts past the write
  // window (#1264), so past the horizon an absent mirror measures the sync, not the
  // calendar.
  const run = (requests: ApprovedEventRequest[], mirrors: EventMirror[]) =>
    runOooEventMismatchCheck({
      load: async () => ({ requests, mirrors }),
      loadAgentNames: async (ids) => new Map(ids.map((id) => [id, `name of ${id}`])),
      nowMs: NOW,
      appBaseUrl: APP,
    });
  // 30 days out, the shape of the first false page.
  const farOut = () =>
    request({ id: "580540c1", startsAt: "2026-11-05T06:00:00.000Z", endsAt: "2026-11-09T06:00:00.000Z" });
  // Straddles the horizon at 2026-10-27T09:00Z.
  const straddling = () =>
    request({ id: "r-straddle", startsAt: "2026-10-25T06:00:00.000Z", endsAt: "2026-10-29T06:00:00.000Z" });

  it("pages nothing for an approved request 30 days out whose mirror is gone", async () => {
    expect(eventMismatchesByAgent([farOut()], [], NOW).size).toBe(0);
    const res = await run([farOut()], []);
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "clear", mismatchedAgents: 0, reachedVerdict: true });
  });

  it("never sends an all-clear off a window past the horizon: nothing was compared", async () => {
    // The two live pages are exactly this: an agent paged, whose only windows ahead
    // are past the horizon. The page stands without repeating until the horizon
    // reaches them and a real comparison ends it.
    firingFamilyMembers.mockImplementation(async () => ["u-heather"]);
    const res = await run([farOut()], []);
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(res.cleared).toBe(0);
  });

  it("still pages a request inside the horizon whose mirror is gone", async () => {
    // The control for the two above: same agent, same empty mirror set, the window
    // just moved inside the horizon, and it pages.
    const res = await run([request()], []);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(sendThrottledAlert.mock.calls[0]![2]).toContain("shows no busy time off event inside that window");
    expect(res).toMatchObject({ status: "mismatched", mismatchedAgents: 1 });
  });

  it("judges a straddling request only up to the horizon: a mirror covering that part pages nothing", async () => {
    const res = await run(
      [straddling()],
      [mirror({ startsAt: "2026-10-25T06:00:00.000Z", endsAt: "2026-10-27T09:00:00.000Z" })],
    );
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(res.mismatchedAgents).toBe(0);
  });

  it("holds back the all-clear for a straddling request, whose tail was not compared", async () => {
    firingFamilyMembers.mockImplementation(async () => ["u-heather"]);
    await run(
      [straddling()],
      [mirror({ startsAt: "2026-10-25T06:00:00.000Z", endsAt: "2026-10-27T09:00:00.000Z" })],
    );
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("pages a straddling request with no mirror, naming only the part it could check", async () => {
    const found = eventMismatchesByAgent([straddling()], [], NOW).get("u-heather")!.found;
    expect(found[0]!.coverage).toEqual({
      kind: "not-blocking",
      unmeasured: { startMs: Date.parse("2026-10-27T09:00:00.000Z"), endMs: Date.parse("2026-10-29T06:00:00.000Z") },
    });
    await run([straddling()], []);
    const text = sendThrottledAlert.mock.calls[0]![2];
    expect(text).not.toContain("inside that window");
    expect(text).toContain("too far ahead to check yet");
  });

  it("treats a calendar never mirrored at all as measuring nothing ahead", async () => {
    const res = await run([request({ mirroredUntil: null })], []);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(res.mismatchedAgents).toBe(0);
  });

  describe("primaryMirroredHorizons (the loader's calendar match)", () => {
    const agents = new Map([
      ["u-heather", { email: "Heather@TryPennie.com" }],
      ["u-no-mail", { email: null }],
    ]);
    it("takes the horizon of the calendar whose id is the agent's address, ignoring case", () => {
      const got = primaryMirroredHorizons(
        [
          { user_id: "u-heather", calendar_id: "team-room@group.calendar.google.com", sync_window_to: "2027-01-01T00:00:00.000Z" },
          { user_id: "u-heather", calendar_id: "heather@trypennie.com", sync_window_to: "2026-10-27T09:00:00.000Z" },
        ],
        agents,
      );
      expect(got.get("u-heather")).toBe("2026-10-27T09:00:00.000Z");
    });
    it("never borrows a secondary calendar's horizon when the primary row is missing", () => {
      const got = primaryMirroredHorizons(
        [{ user_id: "u-heather", calendar_id: "team-room@group.calendar.google.com", sync_window_to: "2027-01-01T00:00:00.000Z" }],
        agents,
      );
      expect(got.has("u-heather")).toBe(false);
    });
    it("takes an agent's only calendar row when its address is not theirs, since only primaries are stored", () => {
      // A Slate address that is an alias of the Google one: the row is still the primary
      // (selectableCalendarIds keeps primaries only, #42), and leaving the agent out would
      // read every window of theirs as unmeasured, silencing the lane for them.
      const got = primaryMirroredHorizons(
        [{ user_id: "u-heather", calendar_id: "h.mclellen@trypennie.com", sync_window_to: "2026-10-27T09:00:00.000Z" }],
        agents,
      );
      expect(got.get("u-heather")).toBe("2026-10-27T09:00:00.000Z");
    });
    it("guesses nothing when an agent has several rows and none is their address", () => {
      const got = primaryMirroredHorizons(
        [
          { user_id: "u-heather", calendar_id: "h.mclellen@trypennie.com", sync_window_to: "2026-10-27T09:00:00.000Z" },
          { user_id: "u-heather", calendar_id: "heather.m@trypennie.com", sync_window_to: "2027-01-01T00:00:00.000Z" },
        ],
        agents,
      );
      expect(got.has("u-heather")).toBe(false);
    });
    it("keeps a primary row's null stamp as null, and matches nothing for an agent with no address", () => {
      const got = primaryMirroredHorizons(
        [
          { user_id: "u-heather", calendar_id: "heather@trypennie.com", sync_window_to: null },
          { user_id: "u-no-mail", calendar_id: "someone@trypennie.com", sync_window_to: "2026-10-27T09:00:00.000Z" },
          { user_id: "u-unknown", calendar_id: "x@trypennie.com", sync_window_to: "2026-10-27T09:00:00.000Z" },
        ],
        agents,
      );
      expect(got.get("u-heather")).toBeNull();
      expect(got.has("u-no-mail")).toBe(false);
      expect(got.has("u-unknown")).toBe(false);
    });
  });

  it("reads a failed calendar horizon read as unreadable: pages nothing, clears nothing", async () => {
    // The loader `unwrap`s the agent_calendars read, so a refused read throws out of
    // `load`, which the lane already treats as a tick that measured nothing.
    firingFamilyMembers.mockImplementation(async () => ["u-heather"]);
    const res = await runOooEventMismatchCheck({
      load: async () => {
        throw new Error("monitor time off mirrored horizon: permission denied");
      },
      loadAgentNames: async () => new Map(),
      nowMs: NOW,
      appBaseUrl: APP,
    });
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "unreadable", reachedVerdict: false });
  });

  describe("mirroredHorizonMs", () => {
    const DAY = 24 * 60 * 60_000;
    it("is the calendar's stamped sync_window_to when that is inside the write window", () => {
      expect(mirroredHorizonMs("2026-10-26T09:00:00.000Z", NOW)).toBe(Date.parse("2026-10-26T09:00:00.000Z"));
    });
    it("never reaches past now plus the write window, whatever is stamped", () => {
      expect(mirroredHorizonMs("2027-06-01T00:00:00.000Z", NOW)).toBe(NOW + BUSY_WINDOW_AHEAD_DAYS * DAY);
    });
    it("is now for a calendar with no stamp, or an unreadable one: nothing ahead is measured", () => {
      expect(mirroredHorizonMs(null, NOW)).toBe(NOW);
      expect(mirroredHorizonMs("not a timestamp", NOW)).toBe(NOW);
    });
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

  it("still pages a shortened event 30 days out: it judges the event Google sent, not the cache", async () => {
    // The cache's horizon (#3655) bounds what an ABSENT mirror can say. The sync has
    // the event itself in hand, which is a measurement at any distance.
    const d = deps({
      events: [
        event({
          start: { dateTime: "2026-11-05T11:30:00-07:00" },
          end: { dateTime: "2026-11-08T23:00:00-07:00" },
        }),
      ],
      loadApproved: vi.fn(async () => [
        request({
          agentEventId: OOO_ID,
          startsAt: "2026-11-05T06:00:00.000Z",
          endsAt: "2026-11-09T06:00:00.000Z",
          mirroredUntil: "2026-10-27T09:00:00.000Z",
        }),
      ]),
    });
    expect(await noticeSyncedOooEvents(d)).toBe(1);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
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
