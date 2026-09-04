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
  formatInactiveAgentBookingsAlert,
  INACTIVE_AGENT_BOOKINGS_KEY,
  INACTIVE_BOOKINGS_ALERT_AFTER_TICKS,
  INACTIVE_BOOKINGS_WINDOW_SECONDS,
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
    { id: "u1", name: "Dana Ruiz", email: "dana@example.com", deactivated: true },
    { id: "u2", name: null, email: "sam@example.com", deactivated: false },
    { id: "u3", name: "Kim Ito", email: "kim@example.com", deactivated: true },
  ];

  it("counts each out-of-pool agent's bookings and drops the ones holding none", () => {
    const holders = inactiveHoldersFromBookings(agents, [
      { assigned_user_id: "u1" },
      { assigned_user_id: "u1" },
      { assigned_user_id: "u2" },
    ]);
    expect(holders.map((h) => [h.userId, h.bookingCount])).toEqual([
      ["u1", 2],
      ["u2", 1],
    ]);
  });

  it("says WHY each agent is out of the pool, so the remediation differs", () => {
    const holders = inactiveHoldersFromBookings(agents, [
      { assigned_user_id: "u1" },
      { assigned_user_id: "u2" },
    ]);
    expect(holders.find((h) => h.userId === "u1")?.reason).toBe("deactivated");
    expect(holders.find((h) => h.userId === "u2")?.reason).toBe("not_bookable");
  });

  it("ignores a booking assigned to someone still in the pool", () => {
    const holders = inactiveHoldersFromBookings(agents, [
      { assigned_user_id: "still-active" },
      { assigned_user_id: null },
    ]);
    expect(holders).toEqual([]);
  });

  it("orders the worst holder first, so a truncated list names the biggest gap", () => {
    const holders = inactiveHoldersFromBookings(agents, [
      { assigned_user_id: "u1" },
      { assigned_user_id: "u3" },
      { assigned_user_id: "u3" },
      { assigned_user_id: "u3" },
    ]);
    expect(holders.map((h) => h.userId)).toEqual(["u3", "u1"]);
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
