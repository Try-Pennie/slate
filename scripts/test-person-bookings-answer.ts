// #3476: reading `find_active_bookings_for_person`'s answer.
//
// The answer is the lead's active bookings, and an EMPTY one is the specific answer
// "this lead has no call booked", the one that lets a second booking be made for
// somebody who already has one (#1641). So an answer this cannot read is REFUSED by
// name, never read as no rows. The fixture is the one the real database suite holds
// the function's answer to (scripts/verify-person-bookings-sql.ts, L26).
//
// Run: node --experimental-strip-types scripts/test-person-bookings-answer.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPersonBookings } from "../src/lib/booking/person-bookings-answer.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "person-bookings-answer.json"), "utf8")) as {
  rows: Record<string, unknown>[];
};

function refusal(data: unknown): string | null {
  try {
    readPersonBookings(data);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// --- rows are read whole, with their world ------------------------------------------------
{
  const rows = readPersonBookings(fixture.rows);
  eq(rows.length, 2, "both rows");
  eq(rows[0]!.id, "20000000-0000-4000-8000-000000000001", "each row's booking id");
  eq(rows[0]!.attendee_email, "dana@example.com", "carrying its columns");
  eq(rows[0]!.isTest, false, "the real world row says so");
  eq(rows[1]!.isTest, true, "and the test world row says so");
  assert(!("is_test" in rows[0]!), "the database's is_test is lifted to isTest, not carried twice");
}

// --- empty is an answer, not an error -------------------------------------------------------
eq(readPersonBookings([]).length, 0, "no bookings is an empty list");

// --- what it cannot read it refuses, by name -----------------------------------------------
{
  const cases: [string, unknown, RegExp][] = [
    ["a null answer", null, /not a list/],
    ["an object", { rows: fixture.rows }, /not a list/],
    ["a row that is not an object", [42], /row 0 was not a row/],
    ["a row with no id", [{ ...fixture.rows[0], id: "" }], /row 0 has no id/],
    ["a row with no world", [{ ...fixture.rows[0], is_test: undefined }], /row 0 does not say which world/],
    ["a world that is not a boolean", [{ ...fixture.rows[0], is_test: "false" }], /row 0 does not say which world/],
    ["a row with no status", [{ ...fixture.rows[0], status: null }], /row 0 has no status/],
    ["the same booking twice", [fixture.rows[0], fixture.rows[0]], /twice/],
  ];
  for (const [label, data, why] of cases) {
    const said = refusal(data);
    assert(said !== null && why.test(said), `${label} is refused by name (got ${said ?? "a read"})`);
  }
}

finish();
