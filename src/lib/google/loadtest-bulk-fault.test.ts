import { describe, it, expect, vi, beforeEach } from "vitest";

// #3845: the load run's Google fault pass reaches the confirm's bulk calendar check.
//
// `freeBusyMany` is the verify wave's read, the first live read a confirm makes. Its
// load test branch answered every calendar free with no fault check, so a fault pass
// never reached the wave's "could not read, ask the agent directly" branch, nor the
// unverified re-route behind it, and every fault leg that passed said less than it read.
// `scripts/test-loadtest-fault-injection.ts` pins the stub's decision; this pins that the
// REAL `freeBusyMany` calls it (built is not wired, L3).
//
// The flag and the percentage are set at module scope, before the calendar module is
// imported, because both are read once when their modules are evaluated. Vitest runs each
// file in its own fork, so this reaches nothing else.
process.env.SLATE_LOADTEST = "true";
process.env.SLATE_LOADTEST_FAULT_PCT = "100";

const NETWORK = "the bulk read reached the network under SLATE_LOADTEST";
vi.mock("@/lib/google/dwd", () => ({
  getDelegatedToken: async () => {
    throw new Error(NETWORK);
  },
}));

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error(NETWORK);
  });
});

const START = "2026-09-14T15:00:00.000Z";
const END = "2026-09-14T15:20:00.000Z";

describe("the confirm's bulk calendar check under a Google fault pass", () => {
  it("reports every calendar unreadable at 100 percent, without touching Google", async () => {
    const { freeBusyMany } = await import("@/lib/google/calendar");
    const cals = ["a@trypennie.com", "b@trypennie.com", "c@trypennie.com"];

    const read = await freeBusyMany("a@trypennie.com", START, END, cals);

    expect([...read.keys()]).toEqual(cals);
    expect([...read.values()].every((v) => v.error)).toBe(true);
  });

  it("which the verify wave reads as an agent to ask directly, never as free", async () => {
    const { freeBusyMany } = await import("@/lib/google/calendar");
    const { freeAgentsFromBusy } = await import("@/lib/booking/core");
    const agent = { email: "a@trypennie.com", calendarIds: ["a@trypennie.com"] };

    const read = await freeBusyMany(agent.email, START, END, agent.calendarIds);
    const res = freeAgentsFromBusy([agent], read, Date.parse(START), Date.parse(END));

    expect([...res.free]).toEqual([]);
    expect([...res.needsFallback]).toEqual([agent.email]);
  });
});
