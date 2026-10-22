import { describe, it, expect, vi, beforeEach } from "vitest";
import { COVERAGE_PANEL_NAME } from "@/lib/booking/coverage-panel-copy";

// #1242: when the coverage sweep cannot place an appointment it settles the item as
// `unplaceable` (nobody was free and under cap) or, after exhausting its retries,
// `failed`. Both mean the appointment is still assigned to an agent who is not
// going to be there and only a person can resolve it. That outcome reached the
// admin coverage panel and a log line, and nothing else, so "this needs a human"
// depended on a human already looking. Dan, 2026-08-03: "Nobody is going to be
// actively checking slate. so if it needs a human we'll need a slack alert".
//
// Under test is the DECISION: which measured state pages, which clears, and which
// must do neither. The dispatcher is mocked because its calls ARE the behavior.
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(
    async (
      _key: string,
      _cooldownMs: number,
      _body: string,
      _channel?: string,
      _news?: { newestMs: number | null; asOfMs: number },
    ) => {},
  ),
);
const resolveAlert = vi.hoisted(() => vi.fn(async (_key: string, _text: string) => true));

vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, resolveAlert }));

import {
  runCoverageNeedsHumanCheck,
  strandedHoldersFromItems,
  countStranded,
  formatCoverageNeedsHumanAlert,
  formatCoverageNeedsHumanRecovery,
  COVERAGE_NEEDS_HUMAN_KEY,
  SWEEP_FINISH_WAIT_MS,
  decodeSweepCause,
  loadTimeOffWindows,
  strandedHolderNow,
  strandedItemReads,
  type StrandedAppointment,
  type StrandedHolder,
  type StrandedItemRead,
  type StrandedRead,
  type CoverageOutAgent,
  type SweepCause,
} from "./coverage-needs-human";
import { LANE_STALE_BOUNDS_MS } from "./health";
import { formatSlotDay, formatSlotTime } from "@/lib/booking/slot-label";

const COOLDOWN_MS = 60 * 60_000;

const holder = (over: Partial<StrandedHolder> = {}): StrandedHolder => ({
  userId: "u1",
  name: "Dana Ruiz",
  email: "dana@example.com",
  unplaceable: 2,
  failed: 0,
  ...over,
});

const item = (over: Partial<StrandedAppointment> = {}): StrandedAppointment => ({
  bookingId: "bk1",
  outUserId: "u1",
  status: "unplaceable",
  ...over,
});

const AS_OF = Date.parse("2026-10-05T14:50:54Z");

/** What the loader hands the check: holders already counted, plus the news facts. */
const strandedRead = (holders: StrandedHolder[], over: Partial<StrandedRead> = {}): StrandedRead => ({
  holders,
  waiting: 0,
  newestCountableMs: holders.length > 0 ? AS_OF - 60_000 : null,
  asOfMs: AS_OF,
  ...over,
});

const run = (items: StrandedHolder[] | StrandedRead | (() => Promise<StrandedRead>)) =>
  runCoverageNeedsHumanCheck({
    loadStranded:
      typeof items === "function"
        ? items
        : async () => (Array.isArray(items) ? strandedRead(items) : items),
    cooldownMs: COOLDOWN_MS,
  });

beforeEach(() => vi.clearAllMocks());

// --- the grouping -----------------------------------------------------------
describe("strandedHoldersFromItems (#1242)", () => {
  const agents: CoverageOutAgent[] = [
    { id: "u1", name: "Dana Ruiz", email: "dana@example.com" },
    { id: "u2", name: null, email: "sam@example.com" },
  ];

  it("groups by the agent the appointment is stuck on and counts each outcome", () => {
    const holders = strandedHoldersFromItems(
      [
        item({ bookingId: "b1", outUserId: "u1", status: "unplaceable" }),
        item({ bookingId: "b2", outUserId: "u1", status: "failed" }),
        item({ bookingId: "b3", outUserId: "u2", status: "failed" }),
      ],
      agents,
    );
    expect(holders.map((h) => [h.userId, h.unplaceable, h.failed])).toEqual([
      ["u1", 1, 1],
      ["u2", 0, 1],
    ]);
  });

  // The two outcomes need different remediation, so the alert has to keep them
  // apart: nobody being free may just need a different time, whereas a move that
  // kept erroring is usually something systemic.
  it("keeps the two outcomes separate rather than collapsing them to one count", () => {
    const holders = strandedHoldersFromItems(
      [item({ status: "failed" }), item({ bookingId: "b2", status: "failed" })],
      agents,
    );
    expect(holders[0]).toMatchObject({ unplaceable: 0, failed: 2 });
  });

  // A stranded customer must never be dropped for a bookkeeping reason. An agent
  // missing from the roster read is still holding the appointment.
  it("still reports an appointment whose agent is not in the roster", () => {
    const holders = strandedHoldersFromItems([item({ outUserId: "ghost" })], agents);
    expect(holders).toHaveLength(1);
    expect(holders[0].userId).toBe("ghost");
  });

  it("orders the worst holder first, so a truncated list names the biggest gap", () => {
    const holders = strandedHoldersFromItems(
      [
        item({ bookingId: "b1", outUserId: "u1" }),
        item({ bookingId: "b2", outUserId: "u2" }),
        item({ bookingId: "b3", outUserId: "u2" }),
        item({ bookingId: "b4", outUserId: "u2" }),
      ],
      agents,
    );
    expect(holders.map((h) => h.userId)).toEqual(["u2", "u1"]);
  });

  it("returns nothing when no appointment is stranded", () => {
    expect(strandedHoldersFromItems([], agents)).toEqual([]);
  });

  // #3303: a day swept twice has two items per call. Counting items read the
  // active agent's 2 calls as 4.
  it("counts each booking once, however many items name it", () => {
    const holders = strandedHoldersFromItems(
      [item({ bookingId: "b1" }), item({ bookingId: "b1" }), item({ bookingId: "b2" })],
      agents,
    );
    expect(holders[0]).toMatchObject({ userId: "u1", unplaceable: 2, failed: 0 });
  });
});

// --- the copy ---------------------------------------------------------------
describe("formatCoverageNeedsHumanAlert (#1242)", () => {
  it("leads with the customer consequence and says where it is fixed", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ unplaceable: 4 })]);
    // #1876: by the panel's real name, from the constant it titles itself with,
    // so a rename cannot leave this alert sending somebody to a section that is
    // not there (L111).
    expect(text).toContain(COVERAGE_PANEL_NAME);
    expect(text).toContain("dana@example.com");
    expect(text).toContain("4");
  });

  // The preview guard fails an alert that OPENS with the word Slate: in Slack it
  // already arrives under Slate's own name and icon, so the label costs the one
  // fact worth reading first.
  it("does not open with the word Slate", () => {
    expect(formatCoverageNeedsHumanAlert([holder()]).startsWith("Slate")).toBe(false);
  });

  // "1 of 97 bookable agent" shipped once (#1153), so both forms get read.
  it("reads correctly for a single stranded appointment", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ unplaceable: 1, failed: 0 })]);
    expect(text).toContain("1 appointment");
    expect(text).not.toContain("1 appointments");
    expect(text).toContain("that time");
    expect(text).toContain("It is still with an advisor");
  });

  it("reads correctly for several appointments across several agents", () => {
    const text = formatCoverageNeedsHumanAlert([
      holder({ userId: "u1", unplaceable: 2 }),
      holder({ userId: "u2", name: null, email: "sam@example.com", unplaceable: 0, failed: 3 }),
    ]);
    expect(text).toContain("5 appointments");
    expect(text).toContain("sam@example.com");
  });

  // Counting the nouns is not enough: several appointments spread across several
  // advisors still said "still with AN ADVISOR", which satisfied every count assertion
  // and read wrong. Only visible rendered (`pnpm preview:alerts`).
  it("agrees the advisor noun with how many advisors are actually involved", () => {
    const oneAgent = formatCoverageNeedsHumanAlert([holder({ unplaceable: 4 })]);
    expect(oneAgent).toContain("still with an advisor who will not be there");
    const twoAgents = formatCoverageNeedsHumanAlert([
      holder({ userId: "u1", unplaceable: 2 }),
      holder({ userId: "u2", email: "sam@example.com", unplaceable: 2 }),
    ]);
    expect(twoAgents).toContain("still with advisors who will not be there");
    expect(twoAgents).not.toContain("still with an advisor");
  });

  // Why it could not be moved is stated once up front; a move that kept erroring is the
  // exception, called out on its own holder line (#3485 readability, 2026-10-11).
  it("states the reason up front and calls out a move that kept failing", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ unplaceable: 1, failed: 2 })]);
    expect(text).toMatch(/no one else was free/i);
    expect(text).toMatch(/kept failing/i);
  });

  // When EVERY call is a failed move (nobody was ever found to be free), the headline must
  // not claim "no one else was free", a reason that was never measured (review finding).
  it("says the move kept failing, not that no one was free, when every call is a failed move", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ unplaceable: 0, failed: 2 })]);
    expect(text).toMatch(/because the move kept failing/i);
    expect(text).not.toMatch(/no one else was free/i);
  });

  // The failed count is a SUBSET of the total, rendered as "N appointments, M where the
  // move kept failing" so it never reads as N plus M (review finding).
  it("renders the failed count as a subset of the holder total", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ unplaceable: 4, failed: 2 })]);
    expect(text).toContain("6 appointments, 2 where the move kept failing");
  });

  it("caps the named agents and says how many more there are", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      holder({ userId: `u${i}`, email: `a${i}@example.com`, unplaceable: 1 }),
    );
    const text = formatCoverageNeedsHumanAlert(many);
    expect(text).toContain("4 more");
    expect(text).not.toContain("a11@example.com");
  });

  it("never renders a placeholder for a nameless agent", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ name: null, email: "sam@example.com" })]);
    expect(text).not.toMatch(/undefined|null|NaN/);
  });
});

describe("formatCoverageNeedsHumanRecovery (#1242)", () => {
  // The reader is being told to stand down. Repeating the remediation is how an
  // all-clear sends someone to redo work that is already done.
  it("says it is clear without telling anyone to go and fix it", () => {
    const text = formatCoverageNeedsHumanRecovery();
    expect(text).toMatch(/no action is needed|nothing/i);
    expect(text).not.toMatch(/reassign (it|them) from/i);
  });
});

// --- the decision -----------------------------------------------------------
describe("runCoverageNeedsHumanCheck (#1242)", () => {
  // No streak here, deliberately, unlike inactive_agent_bookings. That check needs
  // one because an admin deactivating an agent and then running the coverage panel
  // a minute later is an ordinary sequence that briefly looks like a gap. A give up
  // from a FINISHED sweep is different: the sweep has tried and settled it, so the
  // state is terminal the moment it is observed and waiting only delays telling
  // someone. What a sweep still running has given up on is held back by the loader
  // (#3303, `countStranded` below), not by a streak here.
  it("pages on the first tick that finds a stranded appointment", async () => {
    const res = await run([holder({ unplaceable: 2 })]);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldown, body] = sendThrottledAlert.mock.calls[0];
    expect(key).toBe(COVERAGE_NEEDS_HUMAN_KEY);
    expect(cooldown).toBe(COOLDOWN_MS);
    expect(body).toContain("dana@example.com");
    expect(res).toEqual({ status: "stranded", agents: 1, appointments: 2, waiting: 0 });
  });

  it("counts both outcomes toward the reported total", async () => {
    const res = await run([holder({ unplaceable: 1, failed: 3 })]);
    expect(res).toEqual({ status: "stranded", agents: 1, appointments: 4, waiting: 0 });
  });

  it("clears once a real read comes back with nothing stranded", async () => {
    const res = await run([]);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    const [key, text] = resolveAlert.mock.calls[0];
    expect(key).toBe(COVERAGE_NEEDS_HUMAN_KEY);
    expect(text).toMatch(/no action is needed|nothing/i);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(res).toEqual({ status: "clear", agents: 0, appointments: 0, waiting: 0 });
  });

  // THE failure path (#1134 / #1152). A read that threw measured nothing, and an
  // empty result here is indistinguishable from "nothing is stranded", so
  // announcing recovery off it would clear a real page at the moment the system is
  // least able to tell anyone.
  it("neither pages nor clears anything when the read fails", async () => {
    const res = await run(async () => {
      throw new Error('relation "bulk_reassign_items" does not exist');
    });
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(res).toEqual({ status: "unreadable", agents: 0, appointments: 0, waiting: 0 });
  });

  // Monitoring must never take down the lane it is watching.
  it("does not throw when the page fails to send", async () => {
    sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
    await expect(run([holder()])).resolves.toMatchObject({ status: "stranded" });
  });

  it("does not throw when the all-clear fails to send", async () => {
    resolveAlert.mockRejectedValueOnce(new Error("slack down"));
    await expect(run([])).resolves.toMatchObject({ status: "clear" });
  });

  // #3303: the dispatcher decides whether a page carries news, so it has to be
  // told what this page measured and when. Without these the second page on
  // 2026-10-05 would have waited out the cooldown again.
  it("hands the dispatcher the newest countable moment and when it was measured", async () => {
    const newestCountableMs = Date.parse("2026-10-05T14:52:40Z");
    await run(strandedRead([holder()], { newestCountableMs, asOfMs: AS_OF }));
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(sendThrottledAlert.mock.calls[0][3]).toMatchObject({ news: { newestMs: newestCountableMs, asOfMs: AS_OF } });
  });

  // Give ups held back because their sweep is still running are not a measured
  // zero. Announcing "no customer is left holding an appointment" while a sweep has
  // already given up on one would be a recovery notice off a count that is not
  // finished (#1152), so this tick neither pages nor clears.
  it("neither pages nor clears while every give up is waiting on an unfinished sweep", async () => {
    const res = await run(strandedRead([], { waiting: 2 }));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(res).toEqual({ status: "waiting", agents: 0, appointments: 0, waiting: 2 });
  });

  // #3485 part C: the hourly retry re-arms a stranded call to `pending` for up to a drain
  // cycle. The loader counts such in-flight pending items into `waiting`, so a tick that
  // finds no actionable holders while a retry is in flight must NOT read as resolved and
  // send a false all-clear (#1152): the call is still stranded, just momentarily pending.
  it("neither pages nor clears while a retry holds the only stranded call as pending", async () => {
    const res = await run(strandedRead([], { waiting: 1 }));
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(res).toEqual({ status: "waiting", agents: 0, appointments: 0, waiting: 1 });
  });

  it("pages what finished sweeps gave up on while another sweep is still running", async () => {
    const res = await run(strandedRead([holder({ unplaceable: 2 })], { waiting: 1 }));
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(res).toEqual({ status: "stranded", agents: 1, appointments: 2, waiting: 1 });
  });
});

// --- what counts (#3303) -------------------------------------------------------
// On 2026-10-05 the page said 1 appointment at 14:45:54 and the truth was 4: two
// sweeps over one active agent's day gave up on the same two calls, and a departed
// agent's offboarding sweep gave up on two more. The page counted the first item
// to settle while all three sweeps were still running, and counted items rather
// than calls.
describe("countStranded (#3303)", () => {
  const at = (hms: string) => `2026-10-05T${hms}Z`;
  const ms = (hms: string) => Date.parse(at(hms));
  type Over = Omit<Partial<StrandedItemRead>, "sweep"> & { sweep?: Partial<StrandedItemRead["sweep"]> };
  const give = (over: Over = {}): StrandedItemRead => {
    const { sweep, ...rest } = over;
    return {
      bookingId: "b1",
      status: "unplaceable",
      settledAt: at("14:45:29"),
      assignedUserId: "agent-a",
      assignedAgentInPool: false,
      ...rest,
      sweep: { outUserId: "agent-a", status: "done", updatedAt: at("14:47:24"), fromRedistribute: true, ...sweep },
    };
  };

  it("never counts a give up while its sweep is still running, and says it is waiting", () => {
    const running = give({ sweep: { status: "active", updatedAt: at("14:41:50") } });
    const res = countStranded([running], ms("14:45:54"));
    expect(res.appointments).toEqual([]);
    expect(res.waiting).toBe(1);
    expect(res.newestCountableMs).toBeNull();
  });

  it("counts it once the sweep has finished", () => {
    const res = countStranded([give()], ms("14:50:54"));
    expect(res.appointments).toEqual([{ bookingId: "b1", outUserId: "agent-a", status: "unplaceable" }]);
    expect(res.waiting).toBe(0);
  });

  it("treats a cancelled sweep as finished: nothing more will settle in it", () => {
    const res = countStranded([give({ sweep: { status: "cancelled" } })], ms("14:50:54"));
    expect(res.appointments).toHaveLength(1);
  });

  // A finished sweep's give up became countable when the SWEEP finished. Dating it
  // by when the item settled would put it before a page sent between the two, and
  // a sweep finishing just after a page would then never read as news.
  it("dates a finished sweep's give up by when the sweep finished, not when the item settled", () => {
    const res = countStranded([give()], ms("14:50:54"));
    expect(res.newestCountableMs).toBe(ms("14:47:24"));
  });

  // The reads start after `asOf`, so a sweep can be read as finished with a finish
  // stamp after it. Counting it now would put it on a page whose measurement time
  // precedes it, and the next tick would page it again as news; leaving it for the
  // next tick puts it on exactly one page.
  it("leaves a sweep that finished after the measurement began for the next tick", () => {
    const res = countStranded([give({ sweep: { updatedAt: at("14:50:55") } })], ms("14:50:54"));
    expect(res.appointments).toEqual([]);
    expect(res.waiting).toBe(1);
  });

  // L98: a sweep that stalls must not hold its give ups back for ever.
  it("counts a give up from a sweep still running once it has waited the bound", () => {
    const settled = ms("14:45:29");
    const running = give({ sweep: { status: "active", updatedAt: at("14:41:50") } });
    expect(countStranded([running], settled + SWEEP_FINISH_WAIT_MS - 1).waiting).toBe(1);
    const res = countStranded([running], settled + SWEEP_FINISH_WAIT_MS);
    expect(res.appointments).toHaveLength(1);
    expect(res.newestCountableMs).toBe(settled + SWEEP_FINISH_WAIT_MS);
  });

  it("dates a give up by the bound when its sweep finished even later", () => {
    const settled = ms("14:45:29");
    const late = give({ sweep: { updatedAt: new Date(settled + SWEEP_FINISH_WAIT_MS + 60_000).toISOString() } });
    const res = countStranded([late], settled + SWEEP_FINISH_WAIT_MS + 120_000);
    expect(res.newestCountableMs).toBe(settled + SWEEP_FINISH_WAIT_MS);
  });

  // Measured 2026-10-05: three sweeps took 3m57s, 4m31s and 5m34s from creation to
  // done. The bound has to leave a healthy sweep alone with room to spare, and it
  // should outlast the drain lane's own watchdog, so a drain that has died is
  // reported by that page first rather than read here as give ups.
  it("bounds the wait well above the sweeps measured, and above the drain lane's watchdog", () => {
    const longestMeasured = 5 * 60_000 + 34_000;
    expect(SWEEP_FINISH_WAIT_MS).toBeGreaterThanOrEqual(5 * longestMeasured);
    expect(SWEEP_FINISH_WAIT_MS).toBeGreaterThan(LANE_STALE_BOUNDS_MS["bulk-reassign"]);
  });

  it("counts DISTINCT bookings: one call two sweeps gave up on is one appointment", () => {
    const res = countStranded(
      [
        give({ bookingId: "b1", settledAt: at("14:45:29") }),
        give({ bookingId: "b1", settledAt: at("14:46:12"), status: "failed", sweep: { updatedAt: at("14:47:25") } }),
      ],
      ms("14:50:54"),
    );
    expect(res.appointments).toHaveLength(1);
    // The latest attempt says what happened to it most recently.
    expect(res.appointments[0].status).toBe("failed");
    // It was countable from the first sweep's finish, so the second sweep finishing
    // later is not news about a call the reader was already told about.
    expect(res.newestCountableMs).toBe(ms("14:47:24"));
  });

  it("does not report a call as waiting when a finished sweep already counts it", () => {
    const res = countStranded(
      [give(), give({ settledAt: at("14:49:30"), sweep: { status: "active", updatedAt: at("14:49:00") } })],
      ms("14:50:54"),
    );
    expect(res.appointments).toHaveLength(1);
    expect(res.waiting).toBe(0);
  });

  // L200: "still with an agent who will not be there" has to be re-checked at read
  // time. A call moved by any route that does not write the item back is not
  // stranded, whatever the item says.
  it("counts a call only while it is still assigned to the sweep's out agent", () => {
    const moved = give({ assignedUserId: "agent-b" });
    const gone = give({ bookingId: "b2", assignedUserId: null });
    const res = countStranded([moved, gone], ms("14:50:54"));
    expect(res.appointments).toEqual([]);
    expect(res.waiting).toBe(0);
    expect(res.newestCountableMs).toBeNull();
  });

  it("does not hold back a call that has already left the out agent", () => {
    const running = give({ assignedUserId: "agent-b", sweep: { status: "active", updatedAt: at("14:41:50") } });
    expect(countStranded([running], ms("14:45:54")).waiting).toBe(0);
  });

  // A stranded customer must never be dropped for a bookkeeping reason. These are
  // NOT NULL stamps our own code writes, so this is a corrupt row, and it counts;
  // but it has no moment to compare, so it can never be the news that cuts a
  // cooldown short, and reaches the reader on the cooldown instead.
  it("counts a give up whose stamps cannot be read, without calling it news", () => {
    const running = countStranded(
      [give({ settledAt: "not-a-time", sweep: { status: "active", updatedAt: "not-a-time" } })],
      ms("14:50:54"),
    );
    expect(running.appointments).toHaveLength(1);
    expect(running.newestCountableMs).toBeNull();
    const finished = countStranded([give({ settledAt: "nope", sweep: { updatedAt: "nope" } })], ms("14:50:54"));
    expect(finished.appointments).toHaveLength(1);
    expect(finished.newestCountableMs).toBeNull();
  });

  // Today's shape, read at the two ticks that mattered, with the stamps measured
  // in production. J1 and J2 swept the active agent's whole day twice and both gave
  // up on the same two calls; J3 was the departed agent's offboarding.
  describe("2026-10-05", () => {
    type Sweep = StrandedItemRead["sweep"];
    const J1: Sweep = { outUserId: "agent-active", status: "done", updatedAt: at("14:47:24"), fromRedistribute: true };
    const J2: Sweep = { outUserId: "agent-active", status: "done", updatedAt: at("14:47:25"), fromRedistribute: true };
    const J3: Sweep = { outUserId: "agent-departed", status: "done", updatedAt: at("14:47:25"), fromRedistribute: false };
    const todays = (finished: boolean): StrandedItemRead[] => {
      const s = (j: Sweep): Sweep => (finished ? j : { ...j, status: "active" });
      return [
        give({ bookingId: "noon", settledAt: at("14:45:29"), assignedUserId: "agent-active", sweep: s(J1) }),
        give({ bookingId: "340pm", settledAt: at("14:46:05"), assignedUserId: "agent-active", sweep: s(J1) }),
        give({ bookingId: "noon", settledAt: at("14:46:12"), assignedUserId: "agent-active", sweep: s(J2) }),
        give({ bookingId: "340pm", settledAt: at("14:46:22"), assignedUserId: "agent-active", sweep: s(J2) }),
        give({ bookingId: "1230pm", settledAt: at("14:47:07"), assignedUserId: "agent-departed", sweep: s(J3) }),
        give({ bookingId: "100pm", settledAt: at("14:47:13"), assignedUserId: "agent-departed", sweep: s(J3) }),
      ];
    };

    it("pages nothing at 14:45:54, when only the first give up had settled and every sweep was running", () => {
      const res = countStranded(todays(false).slice(0, 1), ms("14:45:54"));
      expect(res.appointments).toEqual([]);
      expect(res.waiting).toBe(1);
    });

    it("counts 4 appointments, not 1 and not 6, once the sweeps have finished", () => {
      const res = countStranded(todays(true), ms("14:50:54"));
      const holders = strandedHoldersFromItems(res.appointments, [
        { id: "agent-active", name: "Active Agent", email: "active@example.com" },
        { id: "agent-departed", name: "Departed Agent", email: "departed@example.com" },
      ]);
      expect(holders.reduce((n, h) => n + h.unplaceable + h.failed, 0)).toBe(4);
      expect(holders.map((h) => [h.userId, h.unplaceable])).toEqual([
        ["agent-active", 2],
        ["agent-departed", 2],
      ]);
      expect(res.newestCountableMs).toBe(ms("14:47:25"));
    });
  });
});

// #3485 part C: a stranded call is retried hourly and only paged ONE HOUR before its
// start, so a call stranded days out stays silent (not a false all-clear, just not yet
// due) while the retry works it, and pages once it is imminent.
describe("countStranded holds a give up until the call is within the paging lead window (#3485)", () => {
  const LEAD = 60 * 60_000;
  const giveFuture = (startsAt: string | undefined): StrandedItemRead => ({
    bookingId: "b1",
    status: "unplaceable",
    settledAt: "2026-10-11T17:22:00Z",
    assignedUserId: "u1",
    assignedAgentInPool: false,
    sweep: { outUserId: "u1", status: "done", updatedAt: "2026-10-11T17:23:00Z", fromRedistribute: false },
    startsAt,
  });

  it("does not count a stranded call more than the lead window before its start", () => {
    const asOf = Date.parse("2026-10-13T15:00:00Z"); // call at 17:00, two hours out
    const res = countStranded([giveFuture("2026-10-13T17:00:00Z")], asOf, LEAD);
    expect(res.appointments).toEqual([]);
    expect(res.waiting).toBe(1);
    expect(res.newestCountableMs).toBeNull();
  });

  it("counts it once within the lead window, dated to when it entered that window", () => {
    const asOf = Date.parse("2026-10-13T16:30:00Z"); // 30 minutes out, inside the hour
    const res = countStranded([giveFuture("2026-10-13T17:00:00Z")], asOf, LEAD);
    expect(res.appointments).toHaveLength(1);
    // Entered the window at start minus lead, which is the news moment, not the old give-up.
    expect(res.newestCountableMs).toBe(Date.parse("2026-10-13T16:00:00Z"));
  });

  it("dates a call GIVEN UP inside the window at the give-up, not before it existed", () => {
    const asOf = Date.parse("2026-10-13T16:30:00Z"); // inside the hour
    // The sweep gave up at 16:25, AFTER the window opened at 16:00 (a time off approved late).
    // The news moment is the give-up (16:25), never the earlier window entry, so a genuinely
    // new stranded call is not mis-dated into the past where the cooldown would swallow it.
    const givenUpLate: StrandedItemRead = {
      ...giveFuture("2026-10-13T17:00:00Z"),
      settledAt: "2026-10-13T16:25:00Z",
      sweep: { outUserId: "u1", status: "done", updatedAt: "2026-10-13T16:25:00Z", fromRedistribute: false },
    };
    const res = countStranded([givenUpLate], asOf, LEAD);
    expect(res.appointments).toHaveLength(1);
    expect(res.newestCountableMs).toBe(Date.parse("2026-10-13T16:25:00Z")); // the give-up, not 16:00
  });

  it("counts regardless of lead when the start is unknown, the safe direction", () => {
    const asOf = Date.parse("2026-10-13T15:00:00Z");
    const res = countStranded([giveFuture(undefined)], asOf, LEAD);
    expect(res.appointments).toHaveLength(1);
  });

  it("applies no lead gate by default, so existing callers are unchanged", () => {
    const asOf = Date.parse("2026-10-13T15:00:00Z");
    const res = countStranded([giveFuture("2026-10-13T17:00:00Z")], asOf);
    expect(res.appointments).toHaveLength(1);
  });
});

// #3597: a coverage sweep fires on a Redistribute tag, but the tag can clear minutes
// later; the agent is then bookable and will take the call, so it is no longer stranded.
// The unplaceable/failed item is a frozen record, so without this the monitor pages for
// ever about a call that is already covered (2026-10-10: James was tagged at 10:00 and
// untagged at 11:00, yet the stranded page fired at 8:40 PM).
describe("countStranded excludes an agent who is bookable again (#3597)", () => {
  const at = (hms: string) => `2026-10-05T${hms}Z`;
  const ms = (hms: string) => Date.parse(at(hms));
  const give = (inPool: boolean, fromRedistribute = true): StrandedItemRead => ({
    bookingId: "b1",
    status: "unplaceable",
    settledAt: at("14:45:29"),
    assignedUserId: "agent-a",
    assignedAgentInPool: inPool,
    sweep: { outUserId: "agent-a", status: "done", updatedAt: at("14:47:24"), fromRedistribute },
  });

  it("does not count a Redistribute give up whose agent is back in the pool, and does not hold it either", () => {
    const res = countStranded([give(true)], ms("14:50:54"));
    expect(res.appointments).toEqual([]);
    expect(res.waiting).toBe(0);
    expect(res.newestCountableMs).toBeNull();
  });

  it("still counts a Redistribute give up while the agent is not in the pool (departed or still tagged)", () => {
    const res = countStranded([give(false)], ms("14:50:54"));
    expect(res.appointments).toHaveLength(1);
  });

  it("STILL counts an approved-time-off give up even when the agent is in the pool (they are away in the window)", () => {
    // The in-pool exclusion is Redistribute-only: an OOO agent stays in the pool but is
    // genuinely away during the window, so their stranded call must keep paging.
    const res = countStranded([give(true, false)], ms("14:50:54"));
    expect(res.appointments).toHaveLength(1);
  });
});

// #3485: the alert says WHY the agent will not be there, and links the advisor to their
// Move-bookings page so a human can act in one tap. The reason lives on the sweep job (the
// time-off request, offboarding, a pool exit, an admin). Dan, 2026-10-11: say the cause and
// the window, never the agent's own free-text reason.
const TIME_OFF: SweepCause = {
  kind: "time-off",
  timeOff: {
    startsAt: "2026-10-13T14:30:00Z",
    endsAt: "2026-10-13T20:00:00Z",
    tzId: "America/Chicago",
    tzLabel: "CT",
  },
};

describe("decodeSweepCause (#3485)", () => {
  const window = {
    startsAt: "2026-10-13T14:30:00Z",
    endsAt: "2026-10-13T20:00:00Z",
    tzId: "America/Chicago",
    tzLabel: "CT",
  };

  it("is time off when the job names an approved request and its window is read", () => {
    // An OOO sweep carries created_by (the approver) AND the request id, so the request
    // must win over admin: the reader needs the absence, not who approved it.
    expect(
      decodeSweepCause({ ooo_request_id: "o1", created_by: "approver" }, window),
    ).toEqual({ kind: "time-off", timeOff: window });
  });

  it("is unknown, never a half-stated reason, when the time-off window could not be read", () => {
    expect(decodeSweepCause({ ooo_request_id: "o1" }, null)).toEqual({ kind: "unknown" });
  });

  it("distinguishes offboarding, a pool exit, a demotion and an admin", () => {
    expect(decodeSweepCause({ offboarding_deactivated_at: "t" })).toEqual({ kind: "offboarded" });
    expect(decodeSweepCause({ redistribute_marked_at: "t" })).toEqual({ kind: "redistribute" });
    expect(decodeSweepCause({ demotion_marked_at: "t" })).toEqual({ kind: "demotion" });
    expect(decodeSweepCause({ created_by: "admin" })).toEqual({ kind: "admin" });
  });

  it("is unknown when the job records no cause at all", () => {
    expect(decodeSweepCause({})).toEqual({ kind: "unknown" });
  });
});

describe("loadTimeOffWindows is best-effort enrichment (#3485)", () => {
  const win = {
    startsAt: "2026-10-13T14:30:00Z",
    endsAt: "2026-10-13T20:00:00Z",
    tzId: "America/Chicago",
    tzLabel: "CT",
  };

  it("returns the windows keyed by request id on success", async () => {
    const map = await loadTimeOffWindows(["o1"], async () => [{ id: "o1", ...win }]);
    expect(map.get("o1")).toEqual(win);
  });

  // THE failure path: a window read is only for the page's reason clause. If it throws it
  // must NOT propagate and take the whole stranded check to "unreadable", which would
  // suppress a real page. It degrades to no window and reports (review finding).
  it("degrades to an empty map and reports, never rethrowing, when the fetch fails", async () => {
    const errs: unknown[] = [];
    const map = await loadTimeOffWindows(
      ["o1"],
      async () => {
        throw new Error("ooo_requests read failed");
      },
      (err) => errs.push(err),
    );
    expect(map.size).toBe(0);
    expect(errs).toHaveLength(1);
  });

  it("does not call the fetch when there are no request ids", async () => {
    let called = false;
    const map = await loadTimeOffWindows([], async () => {
      called = true;
      return [];
    });
    expect(called).toBe(false);
    expect(map.size).toBe(0);
  });
});

describe("the cause flows from the sweep to the holder (#3485)", () => {
  const agents: CoverageOutAgent[] = [{ id: "u1", name: "Dana Ruiz", email: "dana@example.com" }];

  it("carries a single shared cause onto the holder", () => {
    const holders = strandedHoldersFromItems(
      [item({ bookingId: "b1", outUserId: "u1", cause: TIME_OFF })],
      agents,
    );
    expect(holders[0].cause).toMatchObject({ kind: "time-off" });
  });

  it("marks the cause unknown when a holder's items disagree on why", () => {
    const holders = strandedHoldersFromItems(
      [
        item({ bookingId: "b1", outUserId: "u1", cause: TIME_OFF }),
        item({ bookingId: "b2", outUserId: "u1", cause: { kind: "offboarded" } }),
      ],
      agents,
    );
    expect(holders[0].cause).toEqual({ kind: "unknown" });
  });

  // Two separate approved time offs share the KIND but not the window, so stating one
  // window for both would be wrong for the other's calls (review finding, 2026-10-11).
  it("marks the cause unknown when two time offs have different windows", () => {
    const other: SweepCause = {
      kind: "time-off",
      timeOff: { startsAt: "2026-10-20T14:30:00Z", endsAt: "2026-10-20T20:00:00Z", tzId: "America/Chicago", tzLabel: "CT" },
    };
    const holders = strandedHoldersFromItems(
      [
        item({ bookingId: "b1", outUserId: "u1", cause: TIME_OFF }),
        item({ bookingId: "b2", outUserId: "u1", cause: other }),
      ],
      agents,
    );
    expect(holders[0].cause).toEqual({ kind: "unknown" });
  });

  // An unresolved cause on one call is a disagreement: a later call's reason must not be
  // claimed for it (review finding, 2026-10-11), in either order.
  it("stays unknown when one of a holder's calls has no resolved cause", () => {
    const first = strandedHoldersFromItems(
      [item({ bookingId: "b1", outUserId: "u1" }), item({ bookingId: "b2", outUserId: "u1", cause: TIME_OFF })],
      agents,
    );
    expect(first[0].cause).toEqual({ kind: "unknown" });
    const second = strandedHoldersFromItems(
      [item({ bookingId: "b1", outUserId: "u1", cause: TIME_OFF }), item({ bookingId: "b2", outUserId: "u1" })],
      agents,
    );
    expect(second[0].cause).toEqual({ kind: "unknown" });
  });

  it("keeps the time-off cause when two give ups share the same window", () => {
    const holders = strandedHoldersFromItems(
      [
        item({ bookingId: "b1", outUserId: "u1", cause: TIME_OFF }),
        item({ bookingId: "b2", outUserId: "u1", cause: { ...TIME_OFF } }),
      ],
      agents,
    );
    expect(holders[0].cause).toMatchObject({ kind: "time-off" });
  });

  it("carries the sweep cause through countStranded onto the counted appointment", () => {
    const asOf = Date.parse("2026-10-13T12:00:00Z");
    const read: StrandedItemRead = {
      bookingId: "b1",
      status: "unplaceable",
      settledAt: "2026-10-11T17:22:00Z",
      assignedUserId: "u1",
      assignedAgentInPool: true,
      sweep: {
        outUserId: "u1",
        status: "done",
        updatedAt: "2026-10-11T17:22:30Z",
        fromRedistribute: false,
        cause: TIME_OFF,
      },
    };
    const res = countStranded([read], asOf);
    expect(res.appointments[0].cause).toMatchObject({ kind: "time-off" });
  });
});

describe("the coverage alert says why the agent will not be there (#3485)", () => {
  it("states time off and its window when that is the cause", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ unplaceable: 1, cause: TIME_OFF })]);
    expect(text).toMatch(/on time off/i);
    // The window, in the request's own display zone, not the agent's typed reason.
    expect(text).toContain("Oct 13");
    expect(text).toContain("CT");
  });

  it("never blames the daily cap, which is off for most call types", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ unplaceable: 1, cause: TIME_OFF })]);
    expect(text).not.toMatch(/daily cap/i);
  });

  it("gives a short generic reason for the other causes", () => {
    expect(formatCoverageNeedsHumanAlert([holder({ cause: { kind: "offboarded" } })])).toMatch(
      /left the pool/i,
    );
    expect(formatCoverageNeedsHumanAlert([holder({ cause: { kind: "redistribute" } })])).toMatch(
      /routing pool/i,
    );
  });

  it("adds no reason clause when the cause is unknown or absent", () => {
    expect(formatCoverageNeedsHumanAlert([holder({ cause: { kind: "unknown" } })])).not.toMatch(
      /on time off|left the pool|routing pool/i,
    );
    expect(formatCoverageNeedsHumanAlert([holder()])).not.toMatch(
      /on time off|left the pool|routing pool/i,
    );
  });
});

describe("the coverage alert links the advisor, with no booking-id wall (#3485, readability 2026-10-11)", () => {
  const BASE = "https://slate.example.com";

  it("links the advisor to their move-bookings page when a base url is given", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ userId: "u1", unplaceable: 1 })], BASE);
    expect(text).toContain(`<${BASE}/admin/agents/u1|`);
  });

  it("carries no raw booking uuids and no booking links", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ unplaceable: 3 })], BASE);
    expect(text).not.toContain("/admin/bookings/");
    expect(text).toContain("3 appointments");
  });

  it("renders the advisor plainly and no links when no base url is given", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ userId: "u1", unplaceable: 1 })]);
    expect(text).not.toContain("<http");
    expect(text).toContain("Dana Ruiz");
  });

  // A display name is DB text: a stray > ends the link and a stray | splits the label
  // (review finding, 2026-10-11). The label must be escaped.
  it("escapes the advisor label so a name with > or | cannot break the link", () => {
    const text = formatCoverageNeedsHumanAlert(
      [holder({ userId: "u1", name: "A>B|C", email: "a@example.com", unplaceable: 1 })],
      BASE,
    );
    expect(text).toContain("A&gt;B/C");
    expect(text).not.toContain("A>B|C");
  });
});

// Superseded by the readability redesign (2026-10-11): the per-booking uuid list (#3594)
// rendered as a wall on a phone, so the specific calls now live on the advisor's page the
// name links to, and the alert carries no booking ids.
describe("the coverage alert is readable without a booking-id wall", () => {
  it("names how many calls per advisor, not the ids", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ unplaceable: 8 })]);
    expect(text).toContain("8 appointments");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // no uuid anywhere
  });
});

// #3485 Part 2: the page says what happens next and how soon, and names the control that
// actually fixes it. The panel's own button starts the automatic move that just failed, so
// the page sends the reader to each call's Place by hand instead (#3485 comment, 2026-10-12).
describe("the coverage alert says how soon and what happens next (#3485)", () => {
  const ET = "America/New_York";
  const etWhen = (iso: string) => `${formatSlotDay(iso, ET)} at ${formatSlotTime(iso, ET)} ET`;

  it("says when the first stranded call starts, in ET, across every advisor", () => {
    const text = formatCoverageNeedsHumanAlert([
      holder({ userId: "u1", unplaceable: 2, firstStartsAt: "2026-10-13T18:30:00Z" }),
      holder({ userId: "u2", email: "sam@example.com", unplaceable: 1, firstStartsAt: "2026-10-13T16:00:00Z" }),
    ]);
    expect(text).toContain(`The first starts ${etWhen("2026-10-13T16:00:00Z")}.`);
    expect(text).not.toContain(etWhen("2026-10-13T18:30:00Z"));
  });

  it("says one call's start as its own, and says nothing when no start is known", () => {
    expect(formatCoverageNeedsHumanAlert([holder({ unplaceable: 1, firstStartsAt: "2026-10-13T16:00:00Z" })])).toContain(
      `It starts ${etWhen("2026-10-13T16:00:00Z")}.`,
    );
    const unknown = formatCoverageNeedsHumanAlert([holder({ unplaceable: 1 })]);
    expect(unknown).not.toMatch(/starts .* ET/);
    expect(unknown).not.toMatch(/undefined|null|NaN|Invalid/);
  });

  it("says Slate keeps trying until the call starts, but only when no one was free", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ unplaceable: 2 })]);
    expect(text).toMatch(/keeps trying to move them about once an hour until they start/i);
    expect(formatCoverageNeedsHumanAlert([holder({ unplaceable: 1 })])).toMatch(
      /keeps trying to move it about once an hour until it starts/i,
    );
    // A move that kept failing is not retried by the hourly lane, so it is never promised.
    expect(formatCoverageNeedsHumanAlert([holder({ unplaceable: 0, failed: 2 })])).not.toMatch(/once an hour/i);
  });

  it("names Place by hand on each call as the fix, not the panel's automatic move", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ unplaceable: 2 })]);
    expect(text).toContain("Place by hand");
    expect(text).toContain(COVERAGE_PANEL_NAME);
  });
});

describe("the coverage all clear uses one word for the person (#3485)", () => {
  it("says advisor, never agent", () => {
    const text = formatCoverageNeedsHumanRecovery();
    expect(text).toMatch(/advisor/);
    expect(text).not.toMatch(/\bagent\b/);
  });
});

describe("strandedHoldersFromItems carries each call's start to its holder (#3485)", () => {
  it("keeps the earliest start of an advisor's stranded calls", () => {
    const holders = strandedHoldersFromItems(
      [
        item({ bookingId: "b1", startsAt: "2026-10-13T18:30:00Z" }),
        item({ bookingId: "b2", startsAt: "2026-10-13T16:00:00Z" }),
        item({ bookingId: "b3" }),
      ],
      [{ id: "u1", name: "Dana Ruiz", email: "dana@example.com" }],
    );
    expect(holders[0]?.firstStartsAt).toBe("2026-10-13T16:00:00Z");
  });

  it("countStranded hands each appointment its start", () => {
    const read: StrandedItemRead = {
      bookingId: "b1",
      status: "unplaceable",
      settledAt: "2026-10-13T12:00:00Z",
      sweep: { outUserId: "u1", status: "done", updatedAt: "2026-10-13T12:00:00Z", fromRedistribute: false },
      startsAt: "2026-10-13T16:00:00Z",
      assignedUserId: "u1",
      assignedAgentInPool: false,
    };
    const { appointments } = countStranded([read], Date.parse("2026-10-13T15:30:00Z"), 60 * 60_000);
    expect(appointments[0]?.startsAt).toBe("2026-10-13T16:00:00Z");
  });
});

// #3595: the assembly the coverage needs human page and the agent page's standing
// list share, so both hand `countStranded` the same facts about each give up.
describe("strandedHolderNow and strandedItemReads (#3595)", () => {
  const out = { bookable: false, deactivated_at: null, bookable_pending_since: null };
  const back = { bookable: true, deactivated_at: null, bookable_pending_since: null };
  const job = {
    id: "j1",
    out_user_id: "agent-a",
    status: "done" as const,
    updated_at: "2026-10-12T00:02:00Z",
    redistribute_marked_at: "2026-10-11T23:57:00Z",
  };
  const item = { booking_id: "b1", status: "unplaceable", job_id: "j1", updated_at: "2026-10-11T23:55:00Z" };

  it("judges back in the pool by hasLeftPool, and a missing user row as not back", () => {
    const at = { assigned_user_id: "agent-a", starts_at: "2026-10-23T14:00:00Z" };
    expect(strandedHolderNow({ ...at, users: back }).inPool).toBe(true);
    expect(strandedHolderNow({ ...at, users: out }).inPool).toBe(false);
    expect(strandedHolderNow({ ...at, users: { ...back, deactivated_at: "2026-10-01T00:00:00Z" } }).inPool).toBe(false);
    expect(strandedHolderNow({ ...at, users: null }).inPool).toBe(false);
    // Owed an activation: on the way in, not gone.
    expect(strandedHolderNow({ ...at, users: { ...out, bookable_pending_since: "2026-10-21T14:00:00Z" } }).inPool).toBe(true);
  });

  it("joins each item to its sweep and to where its booking stands now", () => {
    const holders = new Map([["b1", { userId: "agent-a", inPool: false, startsAt: "2026-10-23T14:00:00Z" }]]);
    const reads = strandedItemReads([{ ...item, detail: "nobody free" }], holders, new Map([["j1", job]]), () => ({
      kind: "redistribute",
    }) as SweepCause);
    expect(reads).toEqual([
      {
        bookingId: "b1",
        status: "unplaceable",
        settledAt: "2026-10-11T23:55:00Z",
        detail: "nobody free",
        sweep: {
          id: "j1",
          outUserId: "agent-a",
          status: "done",
          updatedAt: "2026-10-12T00:02:00Z",
          fromRedistribute: true,
          cause: { kind: "redistribute" },
        },
        startsAt: "2026-10-23T14:00:00Z",
        assignedUserId: "agent-a",
        assignedAgentInPool: false,
      },
    ]);
  });

  it("drops an item whose booking is no longer active and upcoming, or whose sweep was not read", () => {
    const holders = new Map([["b1", { userId: "agent-a", inPool: false, startsAt: "2026-10-23T14:00:00Z" }]]);
    expect(strandedItemReads([{ ...item, booking_id: "gone" }], holders, new Map([["j1", job]]))).toEqual([]);
    expect(strandedItemReads([{ ...item, job_id: "unread" }], holders, new Map([["j1", job]]))).toEqual([]);
  });

  it("carries the reason and the sweep through countStranded, keeping the latest attempt", () => {
    const holders = new Map([["b1", { userId: "agent-a", inPool: false, startsAt: "2026-10-23T14:00:00Z" }]]);
    const jobs = new Map([
      ["j1", job],
      ["j2", { ...job, id: "j2", updated_at: "2026-10-14T13:06:00Z" }],
    ]);
    const res = countStranded(
      strandedItemReads(
        [
          { ...item, detail: "first" },
          { ...item, job_id: "j2", updated_at: "2026-10-14T13:05:00Z", detail: "second" },
        ],
        holders,
        jobs,
      ),
      Date.parse("2026-10-21T15:00:00Z"),
    );
    expect(res.appointments).toHaveLength(1);
    expect(res.appointments[0]).toMatchObject({ detail: "second", sweepId: "j2" });
  });
});
