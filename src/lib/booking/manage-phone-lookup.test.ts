import { describe, it, expect, vi, beforeEach } from "vitest";

// #2390: a lead corrects their number on the manage page, and the person lookup
// can still find the booking by that number.
//
// The two halves of this used to disagree. `findActiveBookingsForPerson` asks the
// database `attendee_phone = toE164(<the number the caller gave>)`, an exact
// equality on the column, while the manage page wrote `formatPhoneAsTyped`, which
// produces "(215) 555-9999" and never E.164. The query then matched nothing, the
// rows it fetches are the entire input to the one call per person rule, so the
// decision came back `create` and the lead was booked a second time: a second
// invite, a second slot consumed, `booking.created` fired twice.
//
// It is one test rather than two because a test of either half alone cannot see
// the defect. The WRITE is really run (the orchestration function the manage route
// calls, with its deps faked) and the LOOKUP is really run (the shipped call, with
// only the Supabase client faked), and the only thing passing between them is the
// string the write produced, exactly as the column passes it in production. A test
// that computed the expected stored value for itself would prove only that this
// file agrees with itself (L70).

interface Row {
  id: string;
  status: string;
  starts_at: string;
  attendee_phone: string;
  external_id: string | null;
  salesforce_id: string | null;
  attendee_email: string | null;
}

/** The fake bookings table the lookup reads. Seeded per test. */
const rows: Row[] = [];

const rpc = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc }) }));

import { findActiveBookingsForPerson } from "@/lib/booking/service";
import { updateBookingPhone, type BookingDeps } from "@/lib/booking/orchestration";
import type { Booking, Bucket, EventType } from "@/lib/db/types";

const TOKEN = "tok-manage";

/**
 * Just enough of `BookingDeps` for the ONE function under test, written here
 * rather than imported from `scripts/lib/booking-fakes.ts`: a `src` file importing
 * that would pull the whole scripts tree into the app's `tsc` program, which is
 * deliberately excluded from it. A member this write never reaches is absent, so
 * an unexpected call throws rather than passing quietly.
 *
 * The booking carries no `gcal_event_id`, which is what keeps the calendar patch
 * out of the picture: this test is about the value that lands in the column.
 */
function manageDeps(stored: { phone: string | null }) {
  const booking = {
    id: "bk-1",
    manage_token: TOKEN,
    status: "confirmed",
    starts_at: "2026-06-08T13:00:00.000Z",
    ends_at: "2026-06-08T13:30:00.000Z",
    attendee_name: "Dana",
    attendee_email: "dana@example.com",
    attendee_phone: "+12035615295",
    agent_email: "a@x.com",
    gcal_event_id: null,
  } as unknown as Booking;
  const deps = {
    appBaseUrl: () => "https://slate.test",
    loadBookingContext: async (token: string) =>
      token === TOKEN
        ? {
            booking,
            bucket: { id: "bkt1", org_id: "org1", code: "411" } as unknown as Bucket,
            eventType: { id: "et1", name: "Call", duration_min: 30 } as unknown as EventType,
          }
        : null,
    updateBookingContact: async (
      _id: string,
      patch: { attendee_phone?: string },
    ) => {
      if (patch.attendee_phone !== undefined) stored.phone = patch.attendee_phone;
    },
  } as unknown as BookingDeps;
  return deps;
}

/**
 * `find_active_bookings_for_person` (#3476) over `rows`, applying the function's own
 * matching rules as plain equalities: the phone exactly, each strong id against both
 * id columns. Applied rather than recorded, because the whole question here is whether
 * the VALUE the lookup asks for is the value the column holds. Every row here is a real
 * booking (#2660), so the real world sees them all and the test world none. What the
 * real function matches, signal by signal, is proved in Postgres by
 * scripts/verify-person-bookings-sql.ts.
 */
async function lookupRpc(fn: string, args: { p_ids: string[]; p_phone: string | null; p_world: string }) {
  expect(fn).toBe("find_active_bookings_for_person");
  const matched = rows.filter(
    (r) =>
      args.p_world !== "test" &&
      ((args.p_phone !== null && r.attendee_phone === args.p_phone) ||
        args.p_ids.some((id) => r.external_id === id || r.salesforce_id === id)),
  );
  return { data: matched.map((r) => ({ ...r, is_test: false })), error: null };
}

/** Runs the REAL manage page write and returns the string it put in the column. */
async function correctPhoneOnManagePage(typed: string): Promise<string> {
  const stored: { phone: string | null } = { phone: null };
  const res = await updateBookingPhone(TOKEN, typed, manageDeps(stored));
  expect(res.ok, `the correction was refused: ${res.error ?? ""}`).toBe(true);
  expect(stored.phone, "the correction wrote nothing at all").not.toBeNull();
  return stored.phone ?? "";
}

describe("a phone corrected on the manage page (#2390)", () => {
  beforeEach(() => {
    rows.length = 0;
    rpc.mockReset();
    rpc.mockImplementation(lookupRpc);
  });

  // Each punctuation a person really types. The route takes whatever it is sent, so
  // a caller that does not format as it types is the case the column has to survive.
  for (const typed of [
    "2155559999",
    "(215) 555-9999",
    "215 555 9999",
    "215-555-9999",
    "+1 215 555 9999",
    "12155559999",
  ]) {
    it(`is found by the person lookup when it was typed as "${typed}"`, async () => {
      const stored = await correctPhoneOnManagePage(typed);
      rows.push({
        id: "bk-1",
        status: "confirmed",
        starts_at: "2026-06-08T13:00:00.000Z",
        attendee_phone: stored,
        external_id: null,
        salesforce_id: null,
        attendee_email: null,
      });

      // The Regal bot comes back for the same person carrying only the phone: no
      // email, no Salesforce id, no external id. This is the identity the one call
      // per person rule has to work from, and the corrected row is the only row.
      const found = await findActiveBookingsForPerson({
        externalId: null,
        salesforceId: null,
        email: null,
        phone: typed,
      }, { isTest: false });

      expect(found.map((b) => b.id)).toEqual(["bk-1"]);
    });
  }

  it("is found when the bot gives the number in a different punctuation", async () => {
    const stored = await correctPhoneOnManagePage("(215) 555-9999");
    rows.push({
      id: "bk-1",
      status: "confirmed",
      starts_at: "2026-06-08T13:00:00.000Z",
      attendee_phone: stored,
      external_id: null,
      salesforce_id: null,
      attendee_email: null,
    });

    const found = await findActiveBookingsForPerson({
      externalId: null,
      salesforceId: null,
      email: null,
      phone: "215-555-9999",
    }, { isTest: false });

    expect(found.map((b) => b.id)).toEqual(["bk-1"]);
  });

  it("does not drag in somebody else who has no number stored at all", async () => {
    const stored = await correctPhoneOnManagePage("2155559999");
    rows.push(
      {
        id: "bk-1",
        status: "confirmed",
        starts_at: "2026-06-08T13:00:00.000Z",
        attendee_phone: stored,
        external_id: null,
        salesforce_id: null,
        attendee_email: null,
      },
      // A row whose phone was never recorded. A correction that normalised to
      // nothing would be stored as "" and this is the row it would collide with.
      {
        id: "bk-other",
        status: "confirmed",
        starts_at: "2026-06-08T15:00:00.000Z",
        attendee_phone: "",
        external_id: null,
        salesforce_id: null,
        attendee_email: null,
      },
    );

    const found = await findActiveBookingsForPerson({
      externalId: null,
      salesforceId: null,
      email: null,
      phone: "2155559999",
    }, { isTest: false });

    expect(found.map((b) => b.id)).toEqual(["bk-1"]);
  });
});
