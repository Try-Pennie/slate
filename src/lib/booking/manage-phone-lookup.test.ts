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
// calls, with its deps faked) and the LOOKUP is really run (the shipped query, with
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

const from = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

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
 * A chainable Supabase shaped builder over `rows`. `eq` and `ilike` are applied as
 * real filters rather than recorded, because the whole question here is whether the
 * VALUE the query asks for is the value the column holds.
 */
function builder(): Record<string, unknown> {
  let matched = rows.slice();
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.limit = () => q;
  q.order = () => q;
  q.in = (column: string, values: string[]) => {
    matched = matched.filter((r) => values.includes(String(r[column as keyof Row] ?? "")));
    return q;
  };
  q.eq = (column: string, value: string | boolean) => {
    // #2660: the lookup joins the booking's bucket and asks for one world. Every
    // row here is a real booking, so the join filter matches when the real world
    // is asked for and nothing when the test world is.
    if (column === "buckets.is_test") {
      matched = matched.filter((r) => ((r as { is_test?: boolean }).is_test ?? false) === value);
      return q;
    }
    matched = matched.filter((r) => r[column as keyof Row] === value);
    return q;
  };
  q.ilike = (column: string, value: string) => {
    const want = value.toLowerCase();
    matched = matched.filter((r) => String(r[column as keyof Row] ?? "").toLowerCase() === want);
    return q;
  };
  q.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
    Promise.resolve({ data: matched, error: null }).then(resolve);
  return q;
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
    from.mockReset();
    from.mockImplementation(() => builder());
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
