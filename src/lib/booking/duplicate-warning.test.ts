import { describe, it, expect } from "vitest";
import { findDuplicateWarning } from "./orchestration";
import type { BookingDeps } from "./orchestration";
import { findPersonMatch, type PersonWorld } from "./person-dedupe";
import type { Booking } from "@/lib/db/types";

// #626: after a booking succeeds, warn the lead on the confirmation screen if
// they already have ANOTHER active booking — the case a timed-out-then-retried
// confirm can create (first attempt silently succeeded, lead rebooks a new
// time). Reuses findPersonMatch (same identity grading as the dedupe path) and
// findActiveBookingsForPerson; this wrapper only excludes the just-created row
// and maps the match to a manage link.
//
// #1340 splits the two questions the match used to answer at once. "Is this
// likely the same person, so don't double-book them" stays LOOSE (a weak,
// one-signal match still counts). "May we show this person that booking and
// hand over its manage token" is now STRICT: medium (email AND phone) or strong
// (salesforce / external id) only. A shared household phone or a couple on one
// email is a weak match, and the manage token is the only thing protecting that
// booking, so a weak match discloses nothing and offers no link.

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

/** The world each lookup was asked in (#2660), recorded by the fake. */
const askedWorlds: PersonWorld[] = [];

function makeDeps(candidates: Booking[]): Pick<
  BookingDeps,
  "findActiveBookingsForPerson" | "appBaseUrl"
> {
  return {
    findActiveBookingsForPerson: async (_identity, world) => {
      askedWorlds.push(world);
      return candidates;
    },
    appBaseUrl: () => "https://slate.test",
  };
}

const input = {
  excludeBookingId: "b-new",
  salesforceId: null as string | null,
  attendee: { email: "lead@example.com", phone: undefined as string | undefined },
  isTest: false,
};

describe("findDuplicateWarning", () => {
  // #2660: the warning is asked in the world the booking was made in, so a
  // tester's confirmation never names a real lead's call and a lead's never
  // names a test one.
  it("asks the lookup in the world it was told, both ways", async () => {
    askedWorlds.length = 0;
    await findDuplicateWarning({ ...input, isTest: true }, makeDeps([]) as BookingDeps);
    await findDuplicateWarning({ ...input, isTest: false }, makeDeps([]) as BookingDeps);
    expect(askedWorlds).toEqual([{ isTest: true }, { isTest: false }]);
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

  describe("a strong or medium match may be disclosed", () => {
    it("discloses the time + manage url on a salesforce id match (strong)", async () => {
      const other = booking({
        id: "b-old",
        salesforce_id: "sf-1",
        attendee_email: "housemate@example.com",
        starts_at: "2026-07-09T18:00:00.000Z",
        manage_token: "tok-old",
      });
      const deps = makeDeps([booking({ id: "b-new" }), other]);

      const warning = await findDuplicateWarning(
        { ...input, salesforceId: "sf-1", attendee: { email: undefined, phone: undefined } },
        deps as BookingDeps,
      );

      expect(warning).toEqual({
        disclose: true,
        startsAt: "2026-07-09T18:00:00.000Z",
        manageUrl: "https://slate.test/booking/manage/tok-old",
      });
    });

    it("discloses the time + manage url when BOTH email and phone match (medium)", async () => {
      const other = booking({
        id: "b-old",
        attendee_email: "lead@example.com",
        attendee_phone: "+12155550100",
        starts_at: "2026-07-09T18:00:00.000Z",
        manage_token: "tok-old",
      });
      const deps = makeDeps([booking({ id: "b-new" }), other]);

      const warning = await findDuplicateWarning(
        {
          ...input,
          attendee: { email: "lead@example.com", phone: "(215) 555-0100" },
        },
        deps as BookingDeps,
      );

      expect(warning).toEqual({
        disclose: true,
        startsAt: "2026-07-09T18:00:00.000Z",
        manageUrl: "https://slate.test/booking/manage/tok-old",
      });
    });
  });

  describe("a weak match discloses nothing (#1340)", () => {
    it("returns no start time and no manage url on a phone-only match", async () => {
      // A shared household phone: the other booking belongs to someone else.
      const other = booking({
        id: "b-old",
        attendee_email: "housemate@example.com",
        attendee_phone: "+12155550100",
        starts_at: "2026-07-09T18:00:00.000Z",
        manage_token: "tok-old",
      });
      const deps = makeDeps([booking({ id: "b-new" }), other]);

      const warning = await findDuplicateWarning(
        {
          ...input,
          attendee: { email: "lead@example.com", phone: "(215) 555-0100" },
        },
        deps as BookingDeps,
      );

      expect(warning).toEqual({ disclose: false });
      expect(JSON.stringify(warning)).not.toContain("tok-old");
      expect(JSON.stringify(warning)).not.toContain("2026-07-09");
    });

    it("returns no start time and no manage url on an email-only match", async () => {
      // A couple sharing one email address.
      const other = booking({
        id: "b-old",
        attendee_email: "lead@example.com",
        attendee_phone: "+12155559999",
        starts_at: "2026-07-09T18:00:00.000Z",
        manage_token: "tok-old",
      });
      const deps = makeDeps([booking({ id: "b-new" }), other]);

      const warning = await findDuplicateWarning(
        {
          ...input,
          attendee: { email: "lead@example.com", phone: "(215) 555-0100" },
        },
        deps as BookingDeps,
      );

      expect(warning).toEqual({ disclose: false });
      expect(JSON.stringify(warning)).not.toContain("tok-old");
      expect(JSON.stringify(warning)).not.toContain("2026-07-09");
    });
  });

  // The privacy fix must not quietly undo the dedupe: the SAME weak match that
  // is refused disclosure above must still be recognised as the same person, or
  // #1337's refusal of a second booking silently stops firing.
  it("still recognises a phone-only match as the same person, so dedupe is unaffected", () => {
    const other = booking({
      id: "b-old",
      attendee_email: "housemate@example.com",
      attendee_phone: "+12155550100",
    });
    const match = findPersonMatch(
      {
        externalId: null,
        salesforceId: null,
        email: "lead@example.com",
        phone: "(215) 555-0100",
      },
      [other],
    );
    expect(match?.strength).toBe("weak");
    expect(match?.booking.id).toBe("b-old");
  });
});
