import { describe, it, expect, vi, beforeEach } from "vitest";

// #913: classifyCalendarReachability probes the agent's calendar live and maps
// the outcome to reachable / gone / transient. The gone/transient mapping from a
// caught error is a pure function (reachabilityFromError), tested exhaustively in
// scripts/test-google-reachability.ts; here we just pin the reachable path (the
// probe resolves) and that the calendar is actually queried. listCalendars is
// mocked so nothing hits Google.

const cal = vi.hoisted(() => ({ listCalendars: vi.fn() }));
vi.mock("@/lib/google/calendar", () => cal);

import { classifyCalendarReachability, REACHABILITY_PROBE_TIMEOUT_MS } from "./reachability";

beforeEach(() => cal.listCalendars.mockReset());

describe("classifyCalendarReachability", () => {
  it("is reachable when the calendar list resolves, and probes by email under a bounded timeout", async () => {
    cal.listCalendars.mockResolvedValue([{ id: "primary" }]);
    expect(await classifyCalendarReachability("a@b.com")).toBe("reachable");
    // #922: the probe must carry a bound so a hanging Google can't stall the
    // 'Make bookable' click indefinitely.
    expect(cal.listCalendars).toHaveBeenCalledWith("a@b.com", REACHABILITY_PROBE_TIMEOUT_MS);
  });

});
// The abort/timeout -> transient mapping is covered exhaustively in
// scripts/test-google-reachability.ts ("no status (network/abort) = transient"),
// and that listCalendars actually aborts a hung fetch under this bound is proven
// in calendar.test.ts (#922).
