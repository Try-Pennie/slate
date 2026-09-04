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
  vi.fn(async (_key: string, _cooldownMs: number, _body: string) => {}),
);
const resolveAlert = vi.hoisted(() => vi.fn(async (_key: string, _text: string) => true));

vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, resolveAlert }));

import {
  runCoverageNeedsHumanCheck,
  strandedHoldersFromItems,
  formatCoverageNeedsHumanAlert,
  formatCoverageNeedsHumanRecovery,
  COVERAGE_NEEDS_HUMAN_KEY,
  type StrandedAppointment,
  type StrandedHolder,
  type CoverageOutAgent,
} from "./coverage-needs-human";

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

const run = (items: StrandedHolder[] | (() => Promise<StrandedHolder[]>)) =>
  runCoverageNeedsHumanCheck({
    loadStranded: typeof items === "function" ? items : async () => items,
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
  // a minute later is an ordinary sequence that briefly looks like a gap. An
  // `unplaceable` or `failed` item is different: the sweep has already tried and
  // settled it, so the state is terminal the moment it is observed and waiting
  // only delays telling someone. An item still working is `pending` and is not
  // counted here at all.
  it("pages on the first tick that finds a stranded appointment", async () => {
    const res = await run([holder({ unplaceable: 2 })]);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldown, body] = sendThrottledAlert.mock.calls[0];
    expect(key).toBe(COVERAGE_NEEDS_HUMAN_KEY);
    expect(cooldown).toBe(COOLDOWN_MS);
    expect(body).toContain("dana@example.com");
    expect(res).toEqual({ status: "stranded", agents: 1, appointments: 2 });
  });

  it("counts both outcomes toward the reported total", async () => {
    const res = await run([holder({ unplaceable: 1, failed: 3 })]);
    expect(res).toEqual({ status: "stranded", agents: 1, appointments: 4 });
  });

  it("clears once a real read comes back with nothing stranded", async () => {
    const res = await run([]);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    const [key, text] = resolveAlert.mock.calls[0];
    expect(key).toBe(COVERAGE_NEEDS_HUMAN_KEY);
    expect(text).toMatch(/no action is needed|nothing/i);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(res).toEqual({ status: "clear", agents: 0, appointments: 0 });
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
    expect(res).toEqual({ status: "unreadable", agents: 0, appointments: 0 });
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
});
