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
  type StrandedAppointment,
  type StrandedHolder,
  type StrandedItemRead,
  type StrandedRead,
  type CoverageOutAgent,
} from "./coverage-needs-human";
import { LANE_STALE_BOUNDS_MS } from "./health";

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
    expect(text).toMatch(/That customer|it/);
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
  // agents still said "still with AN AGENT", which satisfied every count assertion
  // and read wrong. Only visible rendered (`pnpm preview:alerts`).
  it("agrees the agent noun with how many agents are actually involved", () => {
    const oneAgent = formatCoverageNeedsHumanAlert([holder({ unplaceable: 4 })]);
    expect(oneAgent).toContain("still with an agent who will not be there");
    const twoAgents = formatCoverageNeedsHumanAlert([
      holder({ userId: "u1", unplaceable: 2 }),
      holder({ userId: "u2", email: "sam@example.com", unplaceable: 2 }),
    ]);
    expect(twoAgents).toContain("still with agents who will not be there");
    expect(twoAgents).not.toContain("still with an agent");
  });

  it("says which outcome each agent's appointments hit", () => {
    const text = formatCoverageNeedsHumanAlert([holder({ unplaceable: 1, failed: 2 })]);
    expect(text).toMatch(/could not be placed|nobody was free/i);
    expect(text).toMatch(/kept failing|error/i);
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
    expect(sendThrottledAlert.mock.calls[0][4]).toEqual({ newestMs: newestCountableMs, asOfMs: AS_OF });
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
      ...rest,
      sweep: { outUserId: "agent-a", status: "done", updatedAt: at("14:47:24"), ...sweep },
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
    const J1: Sweep = { outUserId: "agent-active", status: "done", updatedAt: at("14:47:24") };
    const J2: Sweep = { outUserId: "agent-active", status: "done", updatedAt: at("14:47:25") };
    const J3: Sweep = { outUserId: "agent-departed", status: "done", updatedAt: at("14:47:25") };
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
