import {
  isBookingIdQuery,
  buildSearchRows,
  searchBookings,
  type BookingSearchDeps,
  type BookingSearchInput,
} from "../src/lib/booking/search.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- isBookingIdQuery: only a UUID-shaped query is an id lookup ---
assert(
  isBookingIdQuery("ad24625e-31da-4b94-85c0-9a4f9ca71200"),
  "a UUID is treated as a booking-id query",
);
assert(
  isBookingIdQuery("  AD24625E-31DA-4B94-85C0-9A4F9CA71200  "),
  "id match is trimmed + case-insensitive",
);
eq(isBookingIdQuery("jane@acme.co"), false, "an email is not an id query");
eq(isBookingIdQuery("Jane Doe"), false, "a name is not an id query");

// --- buildSearchRows: compact rows with resolved agent name ---
const roster = [
  { id: "u1", name: "Jamie Smith", email: "jamie@x.co" },
  { id: "u2", name: null, email: "ana@x.co" },
];
const bookings: BookingSearchInput[] = [
  {
    id: "b1",
    attendee_name: "Jane Doe",
    attendee_email: "jane@acme.co",
    attendee_phone: null,
    starts_at: "2026-07-02T18:00:00Z",
    assigned_user_id: "u1",
    status: "confirmed",
  },
  {
    id: "b2",
    attendee_name: null,
    attendee_email: "jane@acme.co",
    attendee_phone: "+15551234",
    starts_at: "2026-06-05T14:00:00Z",
    assigned_user_id: "u2",
    status: "cancelled",
  },
  {
    id: "b3",
    attendee_name: "No Agent",
    attendee_email: "x@y.co",
    attendee_phone: null,
    starts_at: "2026-06-01T14:00:00Z",
    assigned_user_id: null,
    status: "confirmed",
  },
];
const rows = buildSearchRows(bookings, roster);
eq(rows.length, 3, "one row per booking");
eq(rows[0].agentName, "Jamie Smith", "agent name resolved from roster");
eq(rows[1].agentName, "ana@x.co", "agent name falls back to email when name null");
eq(rows[2].agentName, "Unassigned", "null assigned agent -> Unassigned");
eq(rows[0].attendeeName, "Jane Doe", "attendee name passed through");
eq(rows[0].startsAt, "2026-07-02T18:00:00Z", "startsAt kept as ISO for the client to format");
eq(rows[1].status, "cancelled", "status passed through");

async function main() {
  function deps(over: Partial<BookingSearchDeps>): BookingSearchDeps {
    return {
      byId: async () => [],
      byText: async () => [],
      users: async () => roster,
      limit: 20,
      ...over,
    };
  }

  // Empty / whitespace query -> no search performed, empty result.
  let idCalled = false;
  let textCalled = false;
  const blank = await searchBookings(
    "org1",
    "   ",
    deps({
      byId: async () => ((idCalled = true), []),
      byText: async () => ((textCalled = true), []),
    }),
  );
  eq(blank.rows.length, 0, "blank query -> empty");
  eq(blank.truncated, false, "blank query -> not truncated");
  assert(!idCalled && !textCalled, "blank query performs no DB read");

  // A non-UUID query routes to text search, NOT the id path.
  let hitIdOnText = false;
  const textMatch = await searchBookings(
    "org1",
    "b1",
    deps({
      byId: async () => ((hitIdOnText = true), []),
      byText: async () => [bookings[0]],
    }),
  );
  eq(textMatch.rows.length, 1, "a non-uuid query matches via text search");
  eq(textMatch.truncated, false, "a small text result is not truncated");
  assert(!hitIdOnText, "a non-uuid query does NOT hit the id path");

  // A real UUID routes to byId with the org.
  const uuid = "ad24625e-31da-4b94-85c0-9a4f9ca71200";
  let hitId = false;
  const idRows = await searchBookings(
    "org1",
    uuid,
    deps({
      byId: async (id, orgId) => {
        hitId = true;
        eq(id, uuid, "byId receives the uuid");
        eq(orgId, "org1", "byId is tenant-scoped");
        return [{ ...bookings[0], id: uuid }];
      },
    }),
  );
  assert(hitId, "uuid query hits the byId path");
  eq(idRows.rows[0].id, uuid, "id row returned");
  eq(idRows.truncated, false, "an id lookup is never truncated");

  // Text query routes to byText with the org + limit and resolves names.
  let textArgs: { q: string; orgId: string; limit: number } | null = null;
  const textRows = await searchBookings(
    "org1",
    "jane",
    deps({
      byText: async (q, orgId, limit) => {
        textArgs = { q, orgId, limit };
        return bookings;
      },
    }),
  );
  eq(textRows.rows.length, 3, "text query returns rows");
  assert(textArgs !== null, "byText was called");
  eq(textArgs!.orgId, "org1", "byText is tenant-scoped");
  eq(textArgs!.limit, 20, "byText carries the bound");
  eq(textRows.rows[0].agentName, "Jamie Smith", "text rows resolve agent names");
  eq(textRows.truncated, false, "3 rows under the bound -> not truncated");

  // A text search that fills the bound is flagged truncated (there may be more).
  const full = await searchBookings(
    "org1",
    "smith",
    deps({
      limit: 2,
      byText: async () => [bookings[0], bookings[1]],
    }),
  );
  eq(full.rows.length, 2, "returns the full page of rows");
  eq(full.truncated, true, "a text result at the bound -> truncated");

  finish();
}

void main();
