// The rows the real database suites seed (scripts/lib/seed-sql.ts, #3489), pinned
// offline. Those suites need Docker and run in the DB replay workflow, so a helper that
// quoted a value wrongly or dropped a column would surface there as a confusing
// failure in whichever suite reached it first. These checks run on every push.
//
// Run: node --experimental-strip-types scripts/test-seed-sql.ts
import { bookingInsertSql, bucketsInsertSql, eventTypesInsertSql, rerouteHoldInsertSql, sqlLiteral } from "./lib/seed-sql.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- a literal is quoted and escaped, or null ------------------------------------------
eq(sqlLiteral("O'Neil"), "'O''Neil'", "a quote inside a value is doubled, never left to end the literal");
eq(sqlLiteral(null), "null", "null is the SQL null, never the string 'null'");
eq(sqlLiteral(undefined), "null", "and so is an absent value");

// --- buckets ------------------------------------------------------------------------------
{
  const one = bucketsInsertSql([{ id: "b1", orgId: "o1", code: "100", name: "Low", eventTypeId: "e1" }]);
  eq(one, "insert into buckets (id, org_id, code, name, event_type_id) values ('b1', 'o1', '100', 'Low', 'e1');", "one bucket, every column named");
  const two = bucketsInsertSql([
    { id: "b1", orgId: "o1", code: "100", name: "Low", eventTypeId: "e1" },
    { id: "b2", orgId: "o1", code: "512", name: "Lead's tier", eventTypeId: "e1" },
  ]);
  assert(two.includes("('b1', 'o1', '100', 'Low', 'e1'), ('b2', 'o1', '512', 'Lead''s tier', 'e1');"), `several buckets in one insert, names escaped (got ${two})`);
}

// --- reroute holds --------------------------------------------------------------------------
{
  const hold = {
    orgId: "o1", bookingId: "bk1", agentUserId: "u1", bufferedStartsAt: "2031-03-04 07:50:00+00", bufferedEndsAt: "2031-03-04 08:30:00+00",
    bookingStartsAt: "2031-03-04 08:00:00+00", bookingEndsAt: "2031-03-04 08:20:00+00", bucketId: "b1",
  };
  const sql = rerouteHoldInsertSql(hold).replace(/\s+/g, " ");
  assert(
    sql.includes("values ('o1', 'bk1', 'u1', '2031-03-04 07:50:00+00', '2031-03-04 08:30:00+00', '2031-03-04 08:00:00+00', '2031-03-04 08:20:00+00', 0, 'b1', 'b1', now() + interval '5 minutes');"),
    `a hold names the booking, the held advisor and both windows in the table's column order, requested and targeted at one bucket, live for five minutes (got ${sql})`,
  );
  const columns = sql.match(/insert into reroute_holds \(([^)]*)\)/)?.[1].split(",").map((c) => c.trim()) ?? [];
  const values = sql.match(/values \((.*)\);$/)?.[1].split(/,(?![^(]*\))/) ?? [];
  eq(columns.length, values.length, "as many values as columns, so no value lands under its neighbour's name");
  assert(rerouteHoldInsertSql({ ...hold, expiresIn: "-1 minute" }).includes("now() + interval '-1 minute'"), "an expired hold is written by its interval, never by sleeping");
}

// --- the two older helpers, unchanged ------------------------------------------------------------
assert(eventTypesInsertSql([{ id: "e1", orgId: "o1", name: "Call", durationMin: 20 }]).endsWith("('e1', 'o1', 'Call', 20, 0, 0);"), "an event type with no buffers gets zero on both sides");
{
  const b = bookingInsertSql({ id: "bk1", orgId: "o1", bucketId: "b1", eventTypeId: "e1", assignedUserId: "u1", startIso: "s", endIso: "e" });
  assert(b.includes("'confirmed'") && b.includes("'gcal-bk1', 'tok-bk1', 'key-bk1', 'routed', 'booking'"), "a booking defaults to confirmed and derives its event, token and key from its id");
}

finish();
