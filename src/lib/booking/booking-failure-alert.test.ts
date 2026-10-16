import { describe, it, expect } from "vitest";
import { bookingFailureAlert } from "./service";
import {
  NoEligibleAgentsError,
  ReservationHeldError,
  VerifyUnavailableError,
  RescheduleLockUnavailableError,
  SlotUnavailableError,
  timeoutAsRetryable,
} from "./orchestration";
import { DeadlineExceededError } from "@/lib/fetch-within-deadline";

// The reactive half of the routing dead-zone monitor (#327) + the verify-outage
// alert (#319): which silent-outage failures warrant a throttled alert, and
// which ordinary failures (a taken slot) do not.
describe("bookingFailureAlert", () => {
  it("alerts on a no-eligible-agents failure, keyed + named per bucket", () => {
    const spec = bookingFailureAlert(new NoEligibleAgentsError("412"));
    // Per-bucket key so two dead buckets don't suppress each other's alert.
    expect(spec?.key).toBe("no_eligible_agents:412");
    expect(spec?.message).toContain("412");
  });

  it("still alerts on a no-eligible-agents failure for a real (non-test) bucket", () => {
    // A real bucket routing to zero agents is a genuine outage: keep paging ops.
    const spec = bookingFailureAlert(new NoEligibleAgentsError("412", false));
    expect(spec?.key).toBe("no_eligible_agents:412");
  });

  it("does NOT alert when the empty bucket is a test bucket (#465)", () => {
    // The smoke test's is_test bucket routing to no eligible agent is expected;
    // the booking still fails as designed, but it must not page ops.
    const spec = bookingFailureAlert(new NoEligibleAgentsError("SMOKE", true));
    expect(spec).toBeNull();
  });

  it("alerts on a verify-on-book outage", () => {
    const spec = bookingFailureAlert(new VerifyUnavailableError());
    expect(spec?.key).toBe("verify_on_book_outage");
  });

  it("alerts on a fail-closed reschedule lock claim (a DB outage, not a conflict) (#479)", () => {
    // Before #479 this reached internalErrorResponse (a generic 500) which fired a
    // per-route internal_error alert. Now it maps to a typed 503 BEFORE that point,
    // so the outage alert must live here or it would be silently dropped.
    const spec = bookingFailureAlert(new RescheduleLockUnavailableError());
    expect(spec?.key).toBe("reschedule_lock_outage");
    expect(spec?.message).toMatch(/reschedule/i);
  });

  it("does NOT page when a lead's retry finds its reservation's lease held by another holder (#3837)", () => {
    // Retryable like the outage (it IS one to the route), but nothing is down: the
    // drain or another retry is working the reservation.
    const err = new ReservationHeldError();
    expect(err).toBeInstanceOf(VerifyUnavailableError);
    expect(bookingFailureAlert(err)).toBeNull();
  });

  it("does NOT alert on an ordinary taken slot", () => {
    expect(bookingFailureAlert(new SlotUnavailableError())).toBeNull();
  });

  it("does NOT alert on an unrelated error", () => {
    expect(bookingFailureAlert(new Error("boom"))).toBeNull();
  });
  // #3663: the booking API timeout path says how far the request got, so a dry run
  // is never worded as a lead waiting on a reservation row.
  it("words a timed out dry run without a lead or a reservation row (#3663)", () => {
    const timeout = timeoutAsRetryable(new DeadlineExceededError("google token mint", 8000));
    const booking = bookingFailureAlert(timeout);
    const dryRun = bookingFailureAlert(timeout, null, "dry-run");
    expect(booking?.message).toContain("booking_reservations");
    expect(dryRun?.key).toBe("verify_on_book_outage");
    expect(dryRun?.message).toMatch(/^A dry run booking check failed/);
    expect(dryRun?.message).not.toMatch(/booking_reservations|\blead\b/);
  });
});
