import { describe, it, expect, vi, beforeEach } from "vitest";
import { COVERAGE_PANEL_NAME } from "@/lib/booking/coverage-panel-copy";

// #1215: an agent who has left the bookable pool (deactivated, or made not
// bookable) vanishes from availability and from every picker, but their already
// booked future appointments stay assigned to them. Nothing connected the two, so
// a customer could hold a confirmed appointment with an advisor who had left and
// the only thing standing between that and a no-show was an admin remembering to
// run the coverage panel.
//
// What is under test here is the DECISION: which measured state pages, which
// clears, and (the part that keeps shipping broken) which states must do neither.
// The streak counter and the alert dispatcher are mocked because they are the
// collaborators whose calls ARE the observable behavior.
const recordConsecutiveStreak = vi.hoisted(() => vi.fn(async () => false));
const clearFailureStreak = vi.hoisted(() => vi.fn(async () => {}));
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _body: string) => {}),
);
const resolveAlert = vi.hoisted(() => vi.fn(async (_key: string, _text: string) => true));

vi.mock("@/lib/notify/streak", () => ({ recordConsecutiveStreak, clearFailureStreak }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, resolveAlert }));

import {
  runInactiveAgentBookingsCheck,
  inactiveHoldersFromBookings,
  demotedHolders,
  demotedAgentsFrom,
  formatInactiveAgentBookingsAlert,
  formatInactiveAgentBookingsRecovery,
  sweepHeldBookingIds,
  formatDemotedAgentBookingsAlert,
  formatDemotedAgentBookingsRecovery,
  demotedAgentBookingsSend,
  DEMOTED_AGENT_BOOKINGS_KEY,
  INACTIVE_AGENT_BOOKINGS_KEY,
  INACTIVE_BOOKINGS_ALERT_AFTER_TICKS,
  INACTIVE_BOOKINGS_WINDOW_SECONDS,
  type DemotedAgent,
  type InactiveHolder,
  type OutOfPoolAgent,
} from "./inactive-agent-bookings";

const COOLDOWN_MS = 60 * 60_000;

const holder = (over: Partial<InactiveHolder> = {}): InactiveHolder => ({
  userId: "u1",
  name: "Dana Ruiz",
  email: "dana@example.com",
  reason: "deactivated",
  bookingCount: 3,
  ...over,
});

const run = (holders: InactiveHolder[] | (() => Promise<InactiveHolder[]>)) =>
  runInactiveAgentBookingsCheck({
    loadHolders: typeof holders === "function" ? holders : async () => holders,
    cooldownMs: COOLDOWN_MS,
  });

beforeEach(() => vi.clearAllMocks());

// --- the grouping: which bookings count, and against whom -------------------
//
// The read side is one bulk query over every out-of-pool agent rather than a
// count per agent, so the "does this booking count" rule lives here, in a pure
// function, where it can be pinned. Status and start-time filtering happen in
// the query too; these cases prove the grouping does not silently re-admit
// something the query is supposed to have excluded.
describe("inactiveHoldersFromBookings (#1215)", () => {
  const agents: OutOfPoolAgent[] = [
    { id: "u1", name: "Dana Ruiz", email: "dana@example.com", deactivated: true, coveredByPendingSweep: false },
    { id: "u2", name: null, email: "sam@example.com", deactivated: false, coveredByPendingSweep: false },
    { id: "u3", name: "Kim Ito", email: "kim@example.com", deactivated: true, coveredByPendingSweep: false },
  ];
  let seq = 0;
  const bk = (assigned_user_id: string | null, id = `bk${++seq}`) => ({ id, assigned_user_id });
  const NONE_HELD = new Set<string>();

  it("counts each out-of-pool agent's bookings and drops the ones holding none", () => {
    const holders = inactiveHoldersFromBookings(agents, [bk("u1"), bk("u1"), bk("u2")], NONE_HELD);
    expect(holders.map((h) => [h.userId, h.bookingCount])).toEqual([
      ["u1", 2],
      ["u2", 1],
    ]);
  });

  it("says WHY each agent is out of the pool, so the remediation differs", () => {
    const holders = inactiveHoldersFromBookings(agents, [bk("u1"), bk("u2")], NONE_HELD);
    expect(holders.find((h) => h.userId === "u1")?.reason).toBe("deactivated");
    expect(holders.find((h) => h.userId === "u2")?.reason).toBe("not_bookable");
  });

  it("ignores a booking assigned to someone still in the pool", () => {
    const holders = inactiveHoldersFromBookings(agents, [bk("still-active"), bk(null)], NONE_HELD);
    expect(holders).toEqual([]);
  });

  it("orders the worst holder first, so a truncated list names the biggest gap", () => {
    const holders = inactiveHoldersFromBookings(agents, [bk("u1"), bk("u3"), bk("u3"), bk("u3")], NONE_HELD);
    expect(holders.map((h) => h.userId)).toEqual(["u3", "u1"]);
  });

  // 2026-10-12: Alana Lambert's offboarding sweep moved 4 calls and could not place 5.
  // The hourly retry kept working them and `coverage_needs_human` paged an hour before
  // each, yet this alert paged every hour all night telling a person to run the sweep
  // that had already failed 18 times. A call a sweep holds belongs to that pipeline.
  it("leaves a booking a coverage sweep already holds to that sweep", () => {
    const holders = inactiveHoldersFromBookings(
      agents,
      [bk("u1", "held1"), bk("u1", "held2")],
      new Set(["held1", "held2"]),
    );
    expect(holders).toEqual([]);
  });

  it("still counts the bookings no sweep has picked up", () => {
    const holders = inactiveHoldersFromBookings(
      agents,
      [bk("u1", "held1"), bk("u1", "loose1"), bk("u3", "loose2")],
      new Set(["held1"]),
    );
    expect(holders.map((h) => [h.userId, h.bookingCount])).toEqual([
      ["u1", 1],
      ["u3", 1],
    ]);
  });

  // #3599: the redistribute turn-off now takes an agent out of the pool a sync before
  // the debounced sweep moves their calls, so for that window they hold calls by design.
  // An agent the roster marked as mid-sweep must not page: the automatic sweep has them.
  it("leaves an agent mid debounced-redistribute-sweep to the sweep, not a page", () => {
    const mid: OutOfPoolAgent[] = [
      { id: "u2", name: null, email: "sam@example.com", deactivated: false, coveredByPendingSweep: true },
    ];
    const holders = inactiveHoldersFromBookings(mid, [bk("u2"), bk("u2")], NONE_HELD);
    expect(holders).toEqual([]);
  });

  it("still pages a DEACTIVATED agent even when marked mid-sweep, since no sweep runs for them", () => {
    // The planner skips deactivated rows, so the sweep never fires for a departed agent.
    // Exempting them would silence the backstop on exactly the #1215 case it exists for.
    const dead: OutOfPoolAgent[] = [
      { id: "u1", name: "Dana", email: "dana@example.com", deactivated: true, coveredByPendingSweep: true },
    ];
    const holders = inactiveHoldersFromBookings(dead, [bk("u1")], NONE_HELD);
    expect(holders.map((h) => h.userId)).toEqual(["u1"]);
  });

  it("still pages a departed agent holding calls even while a different agent is mid-sweep", () => {
    const mixed: OutOfPoolAgent[] = [
      { id: "u1", name: "Dana Ruiz", email: "dana@example.com", deactivated: true, coveredByPendingSweep: false },
      { id: "u2", name: null, email: "sam@example.com", deactivated: false, coveredByPendingSweep: true },
    ];
    const holders = inactiveHoldersFromBookings(mixed, [bk("u1"), bk("u2")], NONE_HELD);
    expect(holders.map((h) => h.userId)).toEqual(["u1"]);
  });
});

// --- which bookings a coverage sweep holds ----------------------------------
//
// The SAME ownership rule the stranded-call page counts by (#3303, #3485): an item still
// in the sweep's hands (pending, or given up as unplaceable or failed) on a sweep whose
// out agent is the booking's CURRENT holder. Anything looser lets one alert hand a call
// to the other while neither pages about it.
describe("sweepHeldBookingIds", () => {
  const holderOf = new Map([
    ["b1", "u1"],
    ["b2", "u1"],
    ["b3", "u1"],
    ["b4", "u1"],
  ]);
  const item = (booking_id: string, status: string, out_user_id = "u1") => ({ booking_id, status, out_user_id });

  it("holds a booking the sweep is still working or gave up on", () => {
    const held = sweepHeldBookingIds(holderOf, [
      item("b1", "pending"),
      item("b2", "unplaceable"),
      item("b3", "failed"),
    ]);
    expect([...held].sort()).toEqual(["b1", "b2", "b3"]);
  });

  // A settled item says nothing about who covers the booking now: moved went elsewhere,
  // skipped and cancelled left the call where it was, with nobody working it.
  it("does not hold a booking whose item is settled", () => {
    const held = sweepHeldBookingIds(holderOf, [
      item("b1", "moved"),
      item("b2", "skipped"),
      item("b3", "cancelled"),
    ]);
    expect(held.size).toBe(0);
  });

  // A call an earlier sweep moved ONTO u1, who has since left: that sweep's item is about
  // its own out agent (u9), not u1, so nothing is working the call for u1's departure.
  it("does not hold a booking on behalf of a sweep for a different agent", () => {
    const held = sweepHeldBookingIds(holderOf, [item("b4", "unplaceable", "u9")]);
    expect(held.size).toBe(0);
  });

  it("does not hold a booking it has no current holder for", () => {
    const held = sweepHeldBookingIds(holderOf, [item("gone", "unplaceable")]);
    expect(held.size).toBe(0);
  });
});

// --- the copy ---------------------------------------------------------------
describe("formatInactiveAgentBookingsAlert (#1215)", () => {
  it("names Slate, the counts, and where to fix it", () => {
    const text = formatInactiveAgentBookingsAlert([holder({ bookingCount: 4 })]);
    expect(text).toContain("Slate");
    expect(text).toContain("4");
    // #1876: the panel's real name, derived rather than spelled here.
    expect(text).toContain(COVERAGE_PANEL_NAME);
    expect(text).toContain("dana@example.com");
  });

  // The page used to say the customers "will meet nobody". That was never true: when the
  // booked advisor does not call, Regal redistributes the lead (Dan, 2026-10-12). What IS
  // true, now that sweep-held calls are excluded, is that nothing has tried to move these.
  it("says no sweep has picked them up, and does not claim the customer meets nobody", () => {
    const text = formatInactiveAgentBookingsAlert([holder({ bookingCount: 5 })]);
    expect(text).not.toContain("meet nobody");
    expect(text).toContain("no coverage sweep has picked up");
  });

  it("the all-clear says a held call is now with a sweep that pages on its own", () => {
    const text = formatInactiveAgentBookingsRecovery();
    expect(text).toContain("picked up by a coverage sweep");
    expect(text).toContain("No action is needed");
  });

  // "1 of 97 bookable agent" shipped once (#1153). Both forms get read.
  it("reads correctly for a single agent holding a single appointment", () => {
    const text = formatInactiveAgentBookingsAlert([holder({ bookingCount: 1 })]);
    expect(text).toContain("1 appointment");
    expect(text).not.toContain("1 appointments");
    expect(text).toContain("1 agent");
    expect(text).not.toContain("1 agents");
  });

  // Counting the nouns is not enough: "1 agent who HAVE left ... still HOLD 1
  // appointment" passed the count assertions above and still read wrong. The
  // verbs have to agree with the subject too, which is only visible rendered.
  it("agrees its verbs with a single agent", () => {
    const text = formatInactiveAgentBookingsAlert([holder({ bookingCount: 1 })]);
    expect(text).toContain("1 agent who has left");
    expect(text).toMatch(/still holds 1 appointment/);
  });

  it("the demotion backstop page says the reroute tried, why it could not, and that it keeps trying", () => {
    const text = formatDemotedAgentBookingsAlert([holder({ reason: "demoted", bookingCount: 2 })]);
    expect(text).toContain("The automatic reroute could not move 2 appointments held by an agent Twilio moved off a pool");
    expect(text).toContain("nobody else in the pool each one needs was free at that time");
    expect(text).toContain("It retries them every hour until they start.");
    expect(text).toContain(`To move one sooner, use ${COVERAGE_PANEL_NAME} on the agent's page in Admin.`);
    expect(text).toContain("Dana Ruiz (dana@example.com), 2 appointments");
    // The opening says why they are held; the line per agent does not say it again (L605).
    expect(text).not.toContain("demoted off a pool");
    expect(text).not.toContain("left the booking pool");
  });

  it("the demotion backstop page speaks of one appointment in the singular", () => {
    const text = formatDemotedAgentBookingsAlert([holder({ reason: "demoted", bookingCount: 1 })]);
    expect(text).toContain("could not move 1 appointment held by an agent Twilio moved off a pool");
    expect(text).toContain("nobody else in the pool it needs was free at that time");
    expect(text).toContain("It retries it every hour until it starts.");
    expect(text).toContain(`To move it sooner, use ${COVERAGE_PANEL_NAME}`);
  });

  it("the demotion backstop page names only the calls it is told are new", () => {
    const calls = (ids: string[]) => ids.map((id) => ({ id, startsAt: "2026-10-30T15:00:00Z" }));
    const holders = [
      holder({ userId: "u1", name: "Kai Example", email: "kai@example.com", reason: "demoted", bookingCount: 3, calls: calls(["k1", "k2", "k3"]) }),
      holder({ userId: "u2", name: "Eli Example", email: "eli@example.com", reason: "demoted", bookingCount: 1, calls: calls(["e1"]) }),
    ];
    const text = formatDemotedAgentBookingsAlert(holders, new Set(["booking:k2", "booking:k3"]));
    expect(text).toContain("could not move 2 appointments held by an agent");
    expect(text).toContain("Kai Example (kai@example.com), 2 appointments");
    expect(text).not.toContain("Eli Example");
  });

  it("the demotion send names one subject per call, and marks only calls starting before the next batch as urgent", () => {
    const now = Date.UTC(2026, 9, 26, 23, 0);
    const at = (ms: number) => new Date(ms).toISOString();
    const HOUR = 60 * 60_000;
    const opts = demotedAgentBookingsSend(
      [
        holder({
          reason: "demoted",
          bookingCount: 3,
          calls: [
            { id: "soon", startsAt: at(now + 2 * HOUR) },
            { id: "edge", startsAt: at(now + 3 * HOUR) },
            { id: "later", startsAt: at(now + 26 * HOUR) },
          ],
        }),
      ],
      now,
    );
    expect(opts.subjects).toEqual(["booking:soon", "booking:edge", "booking:later"]);
    expect(opts.urgentSubjects).toEqual(["booking:soon"]);
    expect(opts.band).toBeUndefined();
    expect(opts.textForFresh?.(["booking:later"])).toContain("could not move 1 appointment");
  });

  it("the demotion send treats a call whose start cannot be read as soon, so it is never held", () => {
    const opts = demotedAgentBookingsSend(
      [holder({ reason: "demoted", bookingCount: 1, calls: [{ id: "x", startsAt: "not a time" }] })],
      Date.UTC(2026, 9, 26, 23, 0),
    );
    expect(opts.urgentSubjects).toEqual(["booking:x"]);
  });

  it("agrees its verbs with several agents", () => {
    const text = formatInactiveAgentBookingsAlert([
      holder({ userId: "u1", bookingCount: 1 }),
      holder({ userId: "u2", bookingCount: 1 }),
    ]);
    expect(text).toContain("2 agents who have left");
    expect(text).toMatch(/still hold 2 appointments/);
  });

  // One customer, one sentence: the singular case must not say "those customers".
  it("speaks of one customer when only one appointment is affected", () => {
    const text = formatInactiveAgentBookingsAlert([holder({ bookingCount: 1 })]);
    expect(text).toContain("That customer is booked");
    expect(text).not.toContain("Those customers");
  });

  it("reads correctly for several agents and several appointments", () => {
    const text = formatInactiveAgentBookingsAlert([
      holder({ userId: "u1", bookingCount: 2 }),
      holder({ userId: "u2", email: "sam@example.com", name: null, reason: "not_bookable", bookingCount: 3 }),
    ]);
    expect(text).toContain("2 agents");
    expect(text).toContain("5 appointments");
  });

  // A wide gap must stay one readable Slack post, not a wall of names.
  it("caps the named agents and says how many more there are", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      holder({ userId: `u${i}`, email: `a${i}@example.com`, bookingCount: 1 }),
    );
    const text = formatInactiveAgentBookingsAlert(many);
    expect(text).toContain("4 more");
    expect(text).not.toContain("a11@example.com");
  });
});

// --- the decision -----------------------------------------------------------
describe("runInactiveAgentBookingsCheck (#1215)", () => {
  it("counts a tick that found holders toward the streak without paging yet", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(false);
    const res = await run([holder()]);
    expect(recordConsecutiveStreak).toHaveBeenCalledWith(
      INACTIVE_AGENT_BOOKINGS_KEY,
      INACTIVE_BOOKINGS_WINDOW_SECONDS,
      INACTIVE_BOOKINGS_ALERT_AFTER_TICKS,
    );
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(res).toEqual({ status: "holding", agents: 1, bookings: 3 });
  });

  it("pages once the holders have persisted across consecutive ticks", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    await run([holder({ bookingCount: 2 })]);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldown, body] = sendThrottledAlert.mock.calls[0];
    expect(key).toBe(INACTIVE_AGENT_BOOKINGS_KEY);
    expect(cooldown).toBe(COOLDOWN_MS);
    expect(body).toContain("Slate");
    expect(body).toContain("dana@example.com");
  });

  // Why the streak exists at all: deactivating an agent and then running the
  // coverage panel are two clicks a minute apart, and `bookable=false` is a
  // reversible pause. Paging on the first tick would fire on both.
  it("stays silent on a single tick, so a deactivate-then-reassign never pages", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(false);
    await run([holder()]);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("says the gap is closed once a real read comes back with no holders", async () => {
    const res = await run([]);
    expect(clearFailureStreak).toHaveBeenCalledWith(INACTIVE_AGENT_BOOKINGS_KEY);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    const [key, text] = resolveAlert.mock.calls[0];
    expect(key).toBe(INACTIVE_AGENT_BOOKINGS_KEY);
    expect(text).toContain("Slate");
    expect(text).toMatch(/no longer|cleared|reassigned/i);
    expect(res).toEqual({ status: "clear", agents: 0, bookings: 0 });
  });

  // THE failure path (#1134 / #1152). A read that threw measured nothing: an
  // empty result here is indistinguishable from "nobody is holding anything", and
  // announcing recovery off it would clear a real page and reset the streak that
  // was about to fire.
  it("neither pages nor clears anything when the read fails", async () => {
    const res = await run(async () => {
      throw new Error("relation \"bookings\" does not exist");
    });
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(res).toEqual({ status: "unreadable", agents: 0, bookings: 0 });
  });

  // Monitoring must never take down the lane it is watching.
  it("does not throw when the page fails to send", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
    await expect(run([holder()])).resolves.toMatchObject({ status: "holding" });
  });

  it("does not throw when the all-clear fails to send", async () => {
    resolveAlert.mockRejectedValueOnce(new Error("slack down"));
    await expect(run([])).resolves.toMatchObject({ status: "clear" });
  });
});

// --- the demotion backstop (#3582): a SEPARATE alert from the pool-exit one -----
describe("the demotion backstop (#3582)", () => {
  const demotedAgent = (over: Partial<DemotedAgent> = {}): DemotedAgent => ({
    id: "d1",
    name: "Del Vane",
    email: "del@example.com",
    unserved: [
      { id: "bk1", startsAt: "2026-10-30T15:00:00Z" },
      { id: "bk2", startsAt: "2026-10-30T16:00:00Z" },
    ],
    coveredByPendingSweep: false,
    ...over,
  });

  it("demotedHolders keeps only past-window demoted agents still holding unserved bookings", () => {
    const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, startsAt: "2026-10-30T15:00:00Z" }));
    const out = demotedHolders([
      demotedAgent({ id: "d1", unserved: calls(1) }),
      demotedAgent({ id: "d2", unserved: calls(3) }),
      demotedAgent({ id: "d3", unserved: [] }), // serves everything: dropped
      demotedAgent({ id: "d4", unserved: calls(5), coveredByPendingSweep: true }), // mid-debounce: dropped
    ]);
    expect(out.map((h) => h.userId)).toEqual(["d2", "d1"]);
    expect(out.every((h) => h.reason === "demoted")).toBe(true);
    expect(out[0].bookingCount).toBe(3);
    expect(out[0].calls).toEqual(calls(3));
  });

  const runDemoted = (holders: InactiveHolder[]) =>
    runInactiveAgentBookingsCheck({
      loadHolders: async () => holders,
      cooldownMs: COOLDOWN_MS,
      key: DEMOTED_AGENT_BOOKINGS_KEY,
      formatAlert: formatDemotedAgentBookingsAlert,
      formatRecovery: formatDemotedAgentBookingsRecovery,
    });

  it("pages on its OWN key with the demotion copy, not the pool-exit alert", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    await runDemoted([holder({ reason: "demoted" })]);
    expect(recordConsecutiveStreak).toHaveBeenCalledWith(
      DEMOTED_AGENT_BOOKINGS_KEY,
      INACTIVE_BOOKINGS_WINDOW_SECONDS,
      INACTIVE_BOOKINGS_ALERT_AFTER_TICKS,
    );
    const [key, , body] = sendThrottledAlert.mock.calls[0];
    expect(key).toBe(DEMOTED_AGENT_BOOKINGS_KEY);
    expect(body).toContain("The automatic reroute could not move");
    expect(body).not.toContain("left the booking pool");
  });

  it("clears on its OWN key with the demotion recovery copy", async () => {
    await runDemoted([]);
    expect(clearFailureStreak).toHaveBeenCalledWith(DEMOTED_AGENT_BOOKINGS_KEY);
    const [key, text] = resolveAlert.mock.calls[0];
    expect(key).toBe(DEMOTED_AGENT_BOOKINGS_KEY);
    expect(text).toContain("No agent moved off a pool is holding");
  });

  // The counts the backstop pages on, built from its reads. A call an admin moved BACK to the
  // demoted advisor (#3615) is theirs by decision: counting it would page about it every day.
  describe("demotedAgentsFrom", () => {
    const stamped = [{ id: "d1", name: "Del Vane", email: "del@example.com", attributes: { debt_team: ["high"] } }];
    const row = (id: string) => ({
      id,
      starts_at: "2026-10-20T15:00:00Z",
      ends_at: "2026-10-20T15:30:00Z",
      attendee_name: null,
      bucket_id: "b-uh",
      kind: "round_robin",
      assigned_user_id: "d1",
    });
    const base = {
      stamped,
      rows: [row("bk1"), row("bk2")],
      criteriaByBucket: new Map([["b-uh", { debt_team: "ultra_high" }]]),
      membersByUser: new Map<string, Set<string>>(),
    };

    it("counts every call the demoted advisor can no longer take", () => {
      const out = demotedAgentsFrom({ ...base, pinnedByUser: new Map() });
      expect(out).toEqual([
        {
          id: "d1",
          name: "Del Vane",
          email: "del@example.com",
          coveredByPendingSweep: false,
          unserved: [
            { id: "bk1", startsAt: "2026-10-20T15:00:00Z" },
            { id: "bk2", startsAt: "2026-10-20T15:00:00Z" },
          ],
        },
      ]);
    });

    it("leaves out a call an admin moved back to them", () => {
      const out = demotedAgentsFrom({ ...base, pinnedByUser: new Map([["d1", new Set(["bk1"])]]) });
      expect(out[0].unserved.map((c) => c.id)).toEqual(["bk2"]);
    });

    it("does not let one advisor's moved back call hide another's", () => {
      const out = demotedAgentsFrom({ ...base, pinnedByUser: new Map([["someone-else", new Set(["bk1"])]]) });
      expect(out[0].unserved.map((c) => c.id)).toEqual(["bk1", "bk2"]);
    });
  });

  it("neither pages nor clears when the demotion read fails, so it cannot false-all-clear", async () => {
    const res = await runInactiveAgentBookingsCheck({
      loadHolders: async () => {
        throw new Error("demotion read failed");
      },
      cooldownMs: COOLDOWN_MS,
      key: DEMOTED_AGENT_BOOKINGS_KEY,
      formatAlert: formatDemotedAgentBookingsAlert,
      formatRecovery: formatDemotedAgentBookingsRecovery,
    });
    expect(res.status).toBe("unreadable");
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });
});
