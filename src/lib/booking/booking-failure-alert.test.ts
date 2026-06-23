import { describe, it, expect } from "vitest";
import { bookingFailureAlert } from "./service";
import {
  NoEligibleAgentsError,
  VerifyUnavailableError,
  SlotUnavailableError,
} from "./orchestration";

// The reactive half of the routing dead-zone monitor (#327) + the verify-outage
// alert (#319): which silent-outage failures warrant a throttled alert, and
// which ordinary failures (a taken slot) do not.
describe("bookingFailureAlert", () => {
  it("alerts on a no-eligible-agents failure, naming the bucket", () => {
    const spec = bookingFailureAlert(new NoEligibleAgentsError("412"));
    expect(spec?.key).toBe("no_eligible_agents");
    expect(spec?.message).toContain("412");
  });

  it("alerts on a verify-on-book outage", () => {
    const spec = bookingFailureAlert(new VerifyUnavailableError());
    expect(spec?.key).toBe("verify_on_book_outage");
  });

  it("does NOT alert on an ordinary taken slot", () => {
    expect(bookingFailureAlert(new SlotUnavailableError())).toBeNull();
  });

  it("does NOT alert on an unrelated error", () => {
    expect(bookingFailureAlert(new Error("boom"))).toBeNull();
  });
});
