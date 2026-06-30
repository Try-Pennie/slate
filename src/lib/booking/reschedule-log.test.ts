import { describe, it, expect } from "vitest";
import { rescheduleLogLine } from "./service";

// #543: the brain returns WHY the in-place agent was declined; the service layer
// turns that into an observability breadcrumb. A routine reassign is INFO (it's a
// normal outcome, not a problem); an outright reschedule failure is WARN.
describe("rescheduleLogLine", () => {
  it("logs nothing when the in-place agent was kept (no decline reason)", () => {
    expect(
      rescheduleLogLine({ ok: true, bookingId: "b1", initiator: "customer", declineReason: null }),
    ).toBeNull();
  });

  it("logs INFO when a declined in-place agent was reassigned successfully", () => {
    const line = rescheduleLogLine({
      ok: true,
      bookingId: "b1",
      initiator: "customer",
      declineReason: "working_hours",
    });
    expect(line?.level).toBe("info");
    expect(line?.message).toContain("b1");
    expect(line?.message).toContain("working_hours");
  });

  it("logs WARN when the reschedule failed entirely, carrying the decline reason + error", () => {
    const line = rescheduleLogLine({
      ok: false,
      bookingId: "b1",
      initiator: "admin",
      declineReason: "buffer",
      errorName: "NoEligibleAgentsError",
    });
    expect(line?.level).toBe("warn");
    expect(line?.message).toContain("buffer");
    expect(line?.message).toContain("NoEligibleAgentsError");
  });

  it("logs WARN with 'n/a' when a failure had no in-place candidate to decline", () => {
    const line = rescheduleLogLine({
      ok: false,
      bookingId: "b1",
      initiator: "customer",
      declineReason: undefined,
      errorName: "SlotUnavailableError",
    });
    expect(line?.level).toBe("warn");
    expect(line?.message).toContain("b1");
    expect(line?.message).toContain("n/a");
  });
});
