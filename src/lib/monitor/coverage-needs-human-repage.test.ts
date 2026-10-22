import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3303, end to end through the REAL dispatcher. The unit tests beside this one mock
// `sendThrottledAlert`, which is right for asserting what the check asks for and
// cannot say whether the page actually goes out: the cooldown is the dispatcher's.
// On 2026-10-05 the cooldown is what hid the rest of the count, so the claim
// "the second tick re-pages" is only proved against the real throttle. Supabase and
// Slack are faked; `alert_state` is a real in-memory key to stamp map with the
// conditional writes Postgres would refuse, so a duplicate can be seen.

const posted = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/notify/slack", () => ({
  slackConfigured: () => true,
  postSlack: async (msg: { text: string }) => {
    // #1825: every post opens with its severity lead; these cases read what follows it.
    const body = withoutSeverityLead(msg.text);
    if (body === null) throw new Error(`post without a severity lead: ${msg.text}`);
    posted.push(body);
    return { ok: true };
  },
}));
vi.mock("@/lib/platform/runtime", () => ({
  isWorkersRuntime: () => true,
  workersRuntimeMarker: () => "Cloudflare-Workers",
}));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// #3801: the shared in-memory alert_state, which keeps the repeat rule's columns, so
// a page reads back what the last one said exactly as it would in production.
vi.mock("@/lib/supabase/admin", async () =>
  (await import("@/lib/notify/alert-state-fake.test-support")).fakeSupabaseAdminModule(),
);
import { alertStateRows as rows } from "@/lib/notify/alert-state-fake.test-support";
import { withoutSeverityLead } from "@/lib/notify/severity-lead";

import {
  countStranded,
  runCoverageNeedsHumanCheck,
  strandedHoldersFromItems,
  type CoverageOutAgent,
  type StrandedItemRead,
  type StrandedRead,
} from "./coverage-needs-human";

const at = (hms: string) => `2026-10-05T${hms}Z`;
const ms = (hms: string) => Date.parse(at(hms));
// The live setting was 30 minutes on the day; the default is an hour. Either way
// every tick below sits well inside it.
const COOLDOWN_MS = 30 * 60_000;

const AGENTS: CoverageOutAgent[] = [
  { id: "agent-active", name: "Active Agent", email: "active@example.com" },
  { id: "agent-departed", name: "Departed Agent", email: "departed@example.com" },
];

type Sweep = StrandedItemRead["sweep"];
const give = (bookingId: string, settled: string, sweep: Sweep): StrandedItemRead => ({
  bookingId,
  status: "unplaceable",
  settledAt: at(settled),
  sweep,
  assignedUserId: sweep.outUserId,
  assignedAgentInPool: false,
});

/**
 * What the route's loader does with the rows it read, minus the database: count,
 * name the holders, and say when it measured. `asOf` is taken before the reads, so
 * it is the tick's clock here.
 */
const readAt = (items: StrandedItemRead[], asOfMs: number): StrandedRead => {
  const counted = countStranded(items, asOfMs);
  return {
    holders: strandedHoldersFromItems(counted.appointments, AGENTS),
    waiting: counted.waiting,
    newestCountableMs: counted.newestCountableMs,
    asOfMs,
  };
};

/** One monitor tick at `hms`: the dispatcher's clock and the check's agree. */
const tick = async (hms: string, items: StrandedItemRead[]) => {
  vi.setSystemTime(ms(hms) + 1_500);
  return runCoverageNeedsHumanCheck({
    loadStranded: async () => readAt(items, ms(hms)),
    cooldownMs: COOLDOWN_MS,
  });
};

beforeEach(() => {
  rows.clear();
  posted.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the coverage give up page on 2026-10-05 (#3303)", () => {
  // The two sweeps over the active agent's whole day, both giving up on the same
  // two calls, finished at the times measured in production.
  const J1: Sweep = { outUserId: "agent-active", status: "done", updatedAt: at("14:47:24"), fromRedistribute: true };
  const J2: Sweep = { outUserId: "agent-active", status: "done", updatedAt: at("14:47:25"), fromRedistribute: true };
  const coverage = [
    give("noon", "14:45:29", J1),
    give("340pm", "14:46:05", J1),
    give("noon", "14:46:12", J2),
    give("340pm", "14:46:22", J2),
  ];
  const offboarding = (sweep: Sweep) => [give("1230pm", "14:47:07", sweep), give("100pm", "14:47:13", sweep)];

  it("re-pages with 4 when the third sweep finishes after the first page, then stays quiet", async () => {
    // The offboarding sweep is still running at the first tick and finishes before
    // the second, so the first page carries the two coverage sweeps' 2 calls.
    const running: Sweep = { outUserId: "agent-departed", status: "active", updatedAt: at("14:43:28"), fromRedistribute: false };
    const finished: Sweep = { ...running, status: "done", updatedAt: at("14:52:40") };

    const first = await tick("14:50:54", [...coverage, ...offboarding(running)]);
    expect(first).toMatchObject({ status: "stranded", appointments: 2, waiting: 2 });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatch(/^2 appointments could not be moved/);

    // Five minutes later, well inside the cooldown, the offboarding sweep has
    // finished. Its two calls became countable after the first page, so it pages.
    const second = await tick("14:55:54", [...coverage, ...offboarding(finished)]);
    expect(second).toMatchObject({ status: "stranded", appointments: 4, waiting: 0 });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatch(/^4 appointments could not be moved/);
    expect(posted[1]).toContain("departed@example.com");

    // Nothing new: the cooldown holds, exactly as before.
    await tick("15:00:54", [...coverage, ...offboarding(finished)]);
    expect(posted).toHaveLength(2);
  });

  it("on the real timeline, says nothing at 14:45:54 and pages the whole 4 at 14:50:54", async () => {
    const J3: Sweep = { outUserId: "agent-departed", status: "done", updatedAt: at("14:47:25"), fromRedistribute: false };
    const runningJ1: Sweep = { ...J1, status: "active", updatedAt: at("14:41:50") };

    // At 14:45:54 only the first item had settled and every sweep was running: the
    // page that went out then said "1 appointment".
    const early = await tick("14:45:54", [give("noon", "14:45:29", runningJ1)]);
    expect(early).toMatchObject({ status: "waiting", appointments: 0, waiting: 1 });
    expect(posted).toEqual([]);

    const next = await tick("14:50:54", [...coverage, ...offboarding(J3)]);
    expect(next).toMatchObject({ status: "stranded", appointments: 4 });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatch(/^4 appointments could not be moved/);
  });
});
