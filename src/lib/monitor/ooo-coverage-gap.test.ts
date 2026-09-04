import { describe, it, expect, vi, beforeEach } from "vitest";
import { COVERAGE_PANEL_NAME } from "@/lib/booking/coverage-panel-copy";

// #1238: an agent on APPROVED time off still holding an appointment inside that
// window, with nothing anywhere saying so.
//
// The narrow slice, decided on the issue once #1242 shipped: this covers the
// bookings a sweep never knew about, so it must never re-report an appointment
// #1242 already names. A sweep that died mid-approval, a retroactive approval, a
// booking made into a window that was already approved, and the straddler that
// begins before the window and runs into it: none of those leave a
// `bulk_reassign_items` row, and none of them are visible today.
//
// What is under test is the DECISION: which measured state pages, which whispers,
// which clears, and (the part this class keeps shipping without) which states must
// do neither. The streak counter and the dispatchers are mocked because their
// calls ARE the observable behaviour.
const recordConsecutiveStreak = vi.hoisted(() => vi.fn(async () => false));
const clearFailureStreak = vi.hoisted(() => vi.fn(async () => {}));
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _body: string) => {}),
);
const sendThrottledInfo = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _body: string) => {}),
);
const resolveAlert = vi.hoisted(() => vi.fn(async (_key: string, _text: string) => true));

vi.mock("@/lib/notify/streak", () => ({ recordConsecutiveStreak, clearFailureStreak }));
vi.mock("@/lib/notify/dispatch", () => ({
  sendThrottledAlert,
  sendThrottledInfo,
  resolveAlert,
}));

import {
  runOooCoverageGapCheck,
  oooCoverageHolders,
  formatOooCoverageGapAlert,
  formatOooCoverageGapRecovery,
  formatOooCoverageGapWhisper,
  OOO_COVERAGE_GAP_KEY,
  OOO_COVERAGE_GAP_LATER_KEY,
  OOO_GAP_ALERT_AFTER_TICKS,
  OOO_GAP_WINDOW_SECONDS,
  OOO_GAP_IMMINENT_HOURS,
  OOO_GAP_WHISPER_COOLDOWN_MS,
  type AbsentAgentBooking,
  type OooAbsence,
  type OooGapHolder,
} from "./ooo-coverage-gap";

const NOW = "2026-08-17T12:00:00.000Z";
const COOLDOWN_MS = 60 * 60_000;
/** Hours after NOW, as an ISO stamp. */
const at = (hours: number): string =>
  new Date(Date.parse(NOW) + hours * 60 * 60_000).toISOString();

const absence = (over: Partial<OooAbsence> = {}): OooAbsence => ({
  requestId: "req1",
  userId: "u1",
  startIso: at(24),
  endIso: at(48),
  ...over,
});

const held = (over: Partial<AbsentAgentBooking> = {}): AbsentAgentBooking => ({
  bookingId: "bk1",
  assignedUserId: "u1",
  startsAtIso: at(25),
  endsAtIso: at(25.5),
  snapshotted: false,
  ...over,
});

const AGENTS = [{ id: "u1", name: "Dana Ruiz", email: "dana@example.com" }];

const holders = (over: Partial<Parameters<typeof oooCoverageHolders>[0]> = {}) =>
  oooCoverageHolders({
    absences: [absence()],
    bookings: [held()],
    agents: AGENTS,
    sweepingUserIds: [],
    nowIso: NOW,
    ...over,
  });

const holder = (over: Partial<OooGapHolder> = {}): OooGapHolder => ({
  userId: "u1",
  name: "Dana Ruiz",
  email: "dana@example.com",
  imminent: 2,
  later: 0,
  soonestStartIso: at(25),
  ...over,
});

const run = (
  load: OooGapHolder[] | (() => Promise<OooGapHolder[]>),
) =>
  runOooCoverageGapCheck({
    loadHolders: typeof load === "function" ? load : async () => load,
    cooldownMs: COOLDOWN_MS,
  });

beforeEach(() => vi.clearAllMocks());

// --- which appointments count -------------------------------------------------

describe("which appointments count as an uncovered absence (#1238)", () => {
  it("reports one an approved absence covers that no sweep ever snapshotted", () => {
    expect(holders()).toEqual([
      {
        userId: "u1",
        name: "Dana Ruiz",
        email: "dana@example.com",
        imminent: 1,
        later: 0,
        soonestStartIso: at(25),
      },
    ]);
  });

  it("says nothing about one a sweep already recorded, whatever came of it", () => {
    // #1242 owns every appointment with a row: it pages on the terminal give-ups
    // and stays quiet while the drain works. Two signals about one row would
    // disagree about the same appointment, and the reader cannot tell which to act on.
    expect(holders({ bookings: [held({ snapshotted: true })] })).toEqual([]);
  });

  it("reports the straddler that begins before the window and runs into it", () => {
    // The case the original coverage query missed and the reason this check exists
    // at all. It has to come out of the SAME predicate the sweep selects with, or
    // the check written to catch the miss repeats it.
    expect(
      holders({
        bookings: [held({ startsAtIso: at(23.5), endsAtIso: at(24.5) })],
      })[0]?.imminent,
    ).toBe(1);
  });

  it("says nothing about one that ends before the absence begins", () => {
    expect(holders({ bookings: [held({ startsAtIso: at(20), endsAtIso: at(20.5) })] })).toEqual(
      [],
    );
  });

  it("says nothing about one that begins after the absence ends", () => {
    expect(holders({ bookings: [held({ startsAtIso: at(60), endsAtIso: at(60.5) })] })).toEqual(
      [],
    );
  });

  it("says nothing about one already under way", () => {
    // Never reported and never moved: the customer may be sitting in it, and there
    // is no action left that helps them.
    expect(
      holders({
        absences: [absence({ startIso: at(-1), endIso: at(48) })],
        bookings: [held({ startsAtIso: at(-0.25), endsAtIso: at(0.25) })],
      }),
    ).toEqual([]);
  });

  it("counts an appointment belonging to a different agent's absence against nobody", () => {
    expect(holders({ bookings: [held({ assignedUserId: "u2" })] })).toEqual([]);
  });

  it("follows the shared predicate on an unreadable stamp rather than inventing an answer", () => {
    // `starts_at` / `ends_at` are NOT NULL timestamptz so this cannot arise from the
    // database; what matters is that this check and the sweep answer identically,
    // because a second definition of "needs covering" is how the page and the panel
    // come to disagree (L16).
    expect(holders({ bookings: [held({ startsAtIso: "not-a-time" })] })).toEqual([]);
  });
});

// --- imminent versus later ----------------------------------------------------

describe("how soon it is decides which channel it reaches (#1238)", () => {
  it("counts one inside the imminent window as imminent", () => {
    const soon = OOO_GAP_IMMINENT_HOURS - 1;
    const h = holders({
      absences: [absence({ startIso: at(0.5), endIso: at(200) })],
      bookings: [held({ startsAtIso: at(soon), endsAtIso: at(soon + 0.5) })],
    })[0];
    expect([h?.imminent, h?.later]).toEqual([1, 0]);
  });

  it("counts one beyond it as later, because acting today changes nothing", () => {
    const far = OOO_GAP_IMMINENT_HOURS + 24;
    const h = holders({
      absences: [absence({ startIso: at(0.5), endIso: at(400) })],
      bookings: [held({ startsAtIso: at(far), endsAtIso: at(far + 0.5) })],
    })[0];
    expect([h?.imminent, h?.later]).toEqual([0, 1]);
  });

  it("names the soonest uncovered start, so the page says how long there is", () => {
    const h = holders({
      absences: [absence({ startIso: at(0.5), endIso: at(400) })],
      bookings: [
        held({ bookingId: "late", startsAtIso: at(40), endsAtIso: at(40.5) }),
        held({ bookingId: "soon", startsAtIso: at(6), endsAtIso: at(6.5) }),
      ],
    })[0];
    expect(h?.soonestStartIso).toBe(at(6));
  });
});

// --- the sweep is working -----------------------------------------------------

describe("an agent whose sweep is still draining (#1238)", () => {
  it("is not reported while a coverage job for them is active", () => {
    // The drain is bounded and observed: the engine flips a job to done only at zero
    // pending, an item that keeps erroring is converted to `failed` (which #1242
    // owns), and a drain lane that stops entirely goes stale in the lane watchdog at
    // 20 minutes. So this suppression cannot become permanent silence.
    expect(holders({ sweepingUserIds: ["u1"] })).toEqual([]);
  });

  it("is reported again once no job for them is active", () => {
    expect(holders({ sweepingUserIds: ["u2"] })).toHaveLength(1);
  });
});

// --- grouping and ordering ----------------------------------------------------

describe("grouping the gaps by agent (#1238)", () => {
  it("puts the agent holding the most imminent appointments first", () => {
    const out = holders({
      absences: [absence({ startIso: at(0.5), endIso: at(400) }), absence({ requestId: "req2", userId: "u2", startIso: at(0.5), endIso: at(400) })],
      bookings: [
        held({ bookingId: "a", assignedUserId: "u2", startsAtIso: at(3), endsAtIso: at(3.5) }),
        held({ bookingId: "b", startsAtIso: at(4), endsAtIso: at(4.5) }),
        held({ bookingId: "c", startsAtIso: at(5), endsAtIso: at(5.5) }),
      ],
      agents: [...AGENTS, { id: "u2", name: "Sam Vale", email: "sam@example.com" }],
    });
    expect(out.map((h) => h.userId)).toEqual(["u1", "u2"]);
  });

  it("still reports an agent the roster read did not return, keyed by id", () => {
    // A customer with nobody to meet must never be dropped for a bookkeeping
    // reason: that is the failure where the count quietly disagrees with reality.
    const out = holders({ agents: [] });
    expect([out.length, out[0]?.userId, out[0]?.name]).toEqual([1, "u1", null]);
  });

  it("counts one appointment once even when two approved absences cover it", () => {
    const out = holders({
      absences: [absence(), absence({ requestId: "req2" })],
    });
    expect(out[0]?.imminent).toBe(1);
  });
});

// --- the decision -------------------------------------------------------------

describe("what one tick does about it (#1238)", () => {
  it("counts toward the streak and stays quiet until it is sustained", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(false);
    const res = await run([holder()]);

    expect(res.status).toBe("holding");
    expect(recordConsecutiveStreak).toHaveBeenCalledWith(
      OOO_COVERAGE_GAP_KEY,
      OOO_GAP_WINDOW_SECONDS,
      OOO_GAP_ALERT_AFTER_TICKS,
    );
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("pages once it is sustained, naming the customer consequence", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    await run([holder()]);

    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldown, body] = sendThrottledAlert.mock.calls[0]!;
    expect([key, cooldown]).toEqual([OOO_COVERAGE_GAP_KEY, COOLDOWN_MS]);
    expect(body).toContain("Dana Ruiz");
  });

  it("clears on a MEASURED zero", async () => {
    const res = await run([]);

    expect(res.status).toBe("clear");
    expect(clearFailureStreak).toHaveBeenCalledWith(OOO_COVERAGE_GAP_KEY);
    expect(resolveAlert).toHaveBeenCalledWith(
      OOO_COVERAGE_GAP_KEY,
      formatOooCoverageGapRecovery(),
    );
  });

  it("does NEITHER when the read failed", async () => {
    // An unread worklist comes back empty and an empty result here is
    // indistinguishable from "every absence is covered". Announcing recovery off it
    // would clear a real page, and clearing the streak would reset the count that was
    // about to fire, both at the moment nothing else can tell anyone (#1134, #1152).
    const res = await run(async () => {
      throw new Error("boom");
    });

    expect(res.status).toBe("unreadable");
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
  });

  it("whispers about the further-out ones and does not page for them", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    await run([holder({ imminent: 0, later: 3 })]);

    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(sendThrottledInfo).toHaveBeenCalledTimes(1);
    const [key, cooldown] = sendThrottledInfo.mock.calls[0]!;
    expect([key, cooldown]).toEqual([OOO_COVERAGE_GAP_LATER_KEY, OOO_GAP_WHISPER_COOLDOWN_MS]);
  });

  it("clears the page while only further-out gaps remain", async () => {
    // Two independent conditions must never share one status (L53). Zero imminent
    // gaps IS the healthy state for the page, whatever the whisper is saying.
    await run([holder({ imminent: 0, later: 3 })]);
    expect(resolveAlert).toHaveBeenCalledWith(
      OOO_COVERAGE_GAP_KEY,
      formatOooCoverageGapRecovery(),
    );
  });

  it("never resolves the whisper, because nobody was asked to act on it", async () => {
    await run([]);
    for (const [key] of resolveAlert.mock.calls) {
      expect(key).not.toBe(OOO_COVERAGE_GAP_LATER_KEY);
    }
  });

  it("keeps the whisper off the page's streak, so a quiet week cannot fire it", async () => {
    await run([holder({ imminent: 0, later: 3 })]);
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
  });
});

// --- the copy -----------------------------------------------------------------

describe("the copy a person reads at 7am (#1238)", () => {
  it("agrees with itself in the singular and the plural", () => {
    const one = formatOooCoverageGapAlert([holder({ imminent: 1 })]);
    const many = formatOooCoverageGapAlert([
      holder({ imminent: 2 }),
      holder({ userId: "u2", name: "Sam Vale", email: "sam@example.com", imminent: 1 }),
    ]);
    expect(one).toContain("1 appointment");
    expect(one).not.toContain("1 appointments");
    expect(many).toContain("3 appointments");
    expect(many).toContain("2 agents");
  });

  it("names who and when, so the reader can triage without opening the admin", () => {
    const body = formatOooCoverageGapAlert([holder()]);
    expect(body).toContain("Dana Ruiz");
    expect(body).toContain("dana@example.com");
  });

  it("does not repeat the remediation in the all-clear", () => {
    // The reader is being told to stand down; carrying the instruction into the
    // recovery is how an all-clear sends someone to redo work already done.
    const recovery = formatOooCoverageGapRecovery();
    expect(recovery.toLowerCase()).not.toContain("reassign");
    expect(recovery).toContain("No action is needed");
  });

  it("says plainly in the whisper that it is not urgent", () => {
    const body = formatOooCoverageGapWhisper([holder({ imminent: 0, later: 2 })]);
    expect(body).toContain("2 appointments");
    // #1876: the panel's real name, derived rather than spelled here.
    expect(body).toContain(COVERAGE_PANEL_NAME);
  });

  it("carries no dash punctuation or emoji in any state", () => {
    const bodies = [
      formatOooCoverageGapAlert([holder()]),
      formatOooCoverageGapRecovery(),
      formatOooCoverageGapWhisper([holder({ imminent: 0, later: 2 })]),
    ];
    for (const body of bodies) {
      // Escapes, not the characters: the pre-push style hook cannot tell a line
      // banning a dash from one using it, and it is right not to try.
      expect(body).not.toMatch(/[\u2014\u2013]/);
      expect(body).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
      // A page arrives under Slate's own app name and icon, so opening with the
      // product name repeats the header and pushes the fact further along the line.
      expect(body.startsWith("Slate")).toBe(false);
    }
  });
});
