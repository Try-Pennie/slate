import { describe, it, expect, vi, beforeEach } from "vitest";

// #1641: the weak-match booking lookup used to read every result as
// `(r.data ?? [])` inside a `for (const r of results)` loop, so a failed query
// came back as an EMPTY candidate list. Empty there does not mean "no failure",
// it means "this lead has no existing call", which is the one answer that lets a
// SECOND booking be created for somebody who already had one. Nothing could see
// it either: the result objects are never named, so neither the original guard
// nor the shape #1629 added could reach them.
//
// This drives the real read (only the Supabase client is faked) and pins both
// directions in one fixture: a healthy pair of queries still finds and dedupes
// the lead's bookings, and a query that ERRORS throws instead of resolving to
// none of them. A negative test alone is satisfied by a fixture that could never
// have found anything in the first place (L159).

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

/** Which filter columns each query ended up carrying, in call order. */
const queriedColumns: string[][] = [];
/** Result per filtered column, so each of the four identity queries can differ. */
const resultByColumn = new Map<string, FakeResult>();

const from = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import {
  findActiveBookingsForPerson,
  findActiveBookingsByStrongIds,
} from "@/lib/booking/service";

function booking(id: string): Record<string, unknown> {
  return {
    id,
    status: "confirmed",
    starts_at: "2026-09-01T14:00:00.000Z",
    manage_token: `tok-${id}`,
  };
}

/** A chainable, thenable Supabase-shaped query builder. */
function builder(): Record<string, unknown> {
  const columns: string[] = [];
  queriedColumns.push(columns);
  const q: Record<string, unknown> = {};
  for (const method of ["select", "in", "limit", "order"]) {
    q[method] = () => q;
  }
  for (const method of ["eq", "ilike"]) {
    q[method] = (column: string) => {
      columns.push(column);
      return q;
    };
  }
  q.then = (resolve: (r: FakeResult) => unknown) => {
    const hit = columns.map((c) => resultByColumn.get(c)).find((r) => r !== undefined);
    return Promise.resolve(hit ?? { data: [], error: null }).then(resolve);
  };
  return q;
}

describe("findActiveBookingsForPerson (the weak-match booking lookup)", () => {
  beforeEach(() => {
    queriedColumns.length = 0;
    resultByColumn.clear();
    from.mockReset();
    from.mockImplementation(() => builder());
  });

  it("finds and dedupes the lead's active bookings when every query reads", async () => {
    resultByColumn.set("external_id", { data: [booking("bk-1")], error: null });
    resultByColumn.set("salesforce_id", {
      data: [booking("bk-1"), booking("bk-2")],
      error: null,
    });

    const rows = await findActiveBookingsForPerson({
      externalId: "ext-1",
      salesforceId: "sf-1",
      email: null,
      phone: null,
    });

    // bk-1 is returned by both queries and must appear once.
    expect(rows.map((b) => b.id).sort()).toEqual(["bk-1", "bk-2"]);
  });

  it("issues a query per identity signal it was given", async () => {
    await findActiveBookingsForPerson({
      externalId: "ext-1",
      salesforceId: "sf-1",
      email: "Lead@Example.com",
      phone: "215 555 0100",
    });
    expect(queriedColumns.flat().sort()).toEqual([
      "attendee_email",
      "attendee_phone",
      "external_id",
      "salesforce_id",
    ]);
  });

  it("throws when the FIRST query errors, rather than reading as no existing call", async () => {
    resultByColumn.set("external_id", {
      data: null,
      error: { message: 'column "external_id" does not exist' },
    });
    resultByColumn.set("salesforce_id", { data: [booking("bk-2")], error: null });

    await expect(
      findActiveBookingsForPerson({
        externalId: "ext-1",
        salesforceId: "sf-1",
        email: null,
        phone: null,
      }),
    ).rejects.toThrow(/read failed \[person booking lookup\]/);
  });

  it("throws when a LATER query errors, so one bad signal cannot pass as none", async () => {
    // The failure has to be caught wherever it lands in the wave, not only on
    // the first result: a per-result unwrap is the difference, and a fixture that
    // only ever fails the first element cannot tell the two apart.
    resultByColumn.set("external_id", { data: [booking("bk-1")], error: null });
    resultByColumn.set("attendee_phone", {
      data: null,
      error: { message: "statement timeout" },
    });

    await expect(
      findActiveBookingsForPerson({
        externalId: "ext-1",
        salesforceId: null,
        email: null,
        phone: "215 555 0100",
      }),
    ).rejects.toThrow(/statement timeout/);
  });

  it("treats a genuinely empty read as no bookings, not as a failure", async () => {
    // PostgREST reports "nothing matched" as a null/empty data with a null error,
    // and unwrap passes that through untouched. A lead with no call must still be
    // able to book.
    resultByColumn.set("external_id", { data: null, error: null });

    const rows = await findActiveBookingsForPerson({
      externalId: "ext-1",
      salesforceId: null,
      email: null,
      phone: null,
    });
    expect(rows).toEqual([]);
  });

  it("returns no bookings without querying when the identity carries no signal", async () => {
    const rows = await findActiveBookingsForPerson({
      externalId: null,
      salesforceId: null,
      email: null,
      phone: null,
    });
    expect(rows).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });
});

// #2657: the lookup API's own fetch. A supplied id may sit in EITHER id column
// (an embed booking holds the lead id in salesforce_id only), so every id is
// read against both, as plain equality reads rather than one `.or(...)` filter
// whose text a caller supplied value would become part of.
describe("findActiveBookingsByStrongIds (the lookup API's fetch)", () => {
  beforeEach(() => {
    queriedColumns.length = 0;
    resultByColumn.clear();
    from.mockReset();
    from.mockImplementation(() => builder());
  });

  it("reads every id against BOTH id columns, one equality read each", async () => {
    await findActiveBookingsByStrongIds(["00Q-lead", "sf-other"]);
    expect(queriedColumns.map((c) => c.join()).sort()).toEqual([
      "external_id",
      "external_id",
      "salesforce_id",
      "salesforce_id",
    ]);
  });

  it("returns a booking found on either column, once", async () => {
    resultByColumn.set("external_id", { data: [booking("bk-api")], error: null });
    resultByColumn.set("salesforce_id", {
      data: [booking("bk-api"), booking("bk-embed")],
      error: null,
    });
    const rows = await findActiveBookingsByStrongIds(["00Q-lead"]);
    expect(rows.map((b) => b.id).sort()).toEqual(["bk-api", "bk-embed"]);
  });

  it("throws when the salesforce_id read errors, rather than reading as no call", async () => {
    // The embed booking lives ONLY on this column, so a swallowed failure here
    // is precisely the 404 the booking confirmed page was getting.
    resultByColumn.set("external_id", { data: [], error: null });
    resultByColumn.set("salesforce_id", { data: null, error: { message: "statement timeout" } });
    await expect(findActiveBookingsByStrongIds(["00Q-lead"])).rejects.toThrow(
      /statement timeout/,
    );
  });

  it("reads nothing for an empty id set", async () => {
    expect(await findActiveBookingsByStrongIds([])).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });
});
