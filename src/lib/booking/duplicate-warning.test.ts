import { describe, it, expect } from "vitest";
import { findDuplicateWarning } from "./orchestration";
import type { BookingDeps } from "./orchestration";
import type { Booking } from "@/lib/db/types";

// #626: after a booking succeeds, warn the lead on the confirmation screen if
// they already have ANOTHER active booking — the case a timed-out-then-retried
// confirm can create (first attempt silently succeeded, lead rebooks a new
// time). Reuses findPersonMatch (same identity grading as the dedupe path) and
// findActiveBookingsForPerson; this wrapper only excludes the just-created row
// and maps the match to a manage link.

const booking = (over: Partial<Booking>): Booking =>
  ({
    id: "b-new",
    starts_at: "2026-07-10T15:00:00.000Z",
    status: "confirmed",
    external_id: null,
    salesforce_id: null,
    attendee_email: "lead@example.com",
    attendee_phone: null,
    manage_token: "tok-new",
    ...over,
  }) as unknown as Booking;

function makeDeps(candidates: Booking[]): Pick<
  BookingDeps,
  "findActiveBookingsForPerson" | "appBaseUrl"
> {
  return {
    findActiveBookingsForPerson: async () => candidates,
    appBaseUrl: () => "https://slate.test",
  };
}

const input = {
  excludeBookingId: "b-new",
  salesforceId: null as string | null,
  attendee: { email: "lead@example.com", phone: undefined as string | undefined },
};

describe("findDuplicateWarning", () => {
  it("returns the other active booking's time + manage url when the lead already has one", async () => {
    const other = booking({
      id: "b-old",
      starts_at: "2026-07-09T18:00:00.000Z",
      manage_token: "tok-old",
    });
    const deps = makeDeps([booking({ id: "b-new" }), other]);

    const warning = await findDuplicateWarning(input, deps as BookingDeps);

    expect(warning).toEqual({
      startsAt: "2026-07-09T18:00:00.000Z",
      manageUrl: "https://slate.test/booking/manage/tok-old",
    });
  });

  it("returns null when the only active booking is the just-created one", async () => {
    const deps = makeDeps([booking({ id: "b-new" })]);
    const warning = await findDuplicateWarning(input, deps as BookingDeps);
    expect(warning).toBeNull();
  });

  it("returns null when no other active booking belongs to the lead", async () => {
    const stranger = booking({
      id: "b-other",
      attendee_email: "someone-else@example.com",
    });
    const deps = makeDeps([booking({ id: "b-new" }), stranger]);
    const warning = await findDuplicateWarning(input, deps as BookingDeps);
    expect(warning).toBeNull();
  });
});
