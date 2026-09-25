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

/** The WORLD each query was scoped to (#2660): the `buckets.is_test` value it
 *  carried, in call order, kept apart from the identity columns above. */
const queriedWorlds: unknown[][] = [];
/** The projection each query asked for, so the bucket join can be asserted. */
const selects: string[] = [];

/** Every identity filter as a column and the value it was given, so a test can
 *  say WHICH id was read against which column (#2663). */
const queriedPairs: [string, unknown][] = [];

/** A chainable, thenable Supabase-shaped query builder. */
function builder(): Record<string, unknown> {
  const columns: string[] = [];
  const worlds: unknown[] = [];
  queriedColumns.push(columns);
  queriedWorlds.push(worlds);
  const q: Record<string, unknown> = {};
  for (const method of ["in", "limit", "order"]) {
    q[method] = () => q;
  }
  q.select = (projection: string) => {
    selects.push(projection);
    return q;
  };
  for (const method of ["eq", "ilike"]) {
    q[method] = (column: string, value: unknown) => {
      if (column === "buckets.is_test") worlds.push(value);
      else {
        columns.push(column);
        queriedPairs.push([column, value]);
      }
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
    queriedWorlds.length = 0;
    queriedPairs.length = 0;
    selects.length = 0;
    resultByColumn.clear();
    from.mockReset();
    from.mockImplementation(() => builder());
  });

  // #2660: a test booking and a real booking live in different WORLDS, and the
  // person reads are scoped to one of them. Without this a tester who typed a
  // real lead's id into a test link was shown that lead's name, number and a
  // Cancel on their real call, and a test booking under an address later REFUSED
  // the real lead using it (red team finding 2). Both directions, one fixture.
  describe("reads in one world (#2660)", () => {
    it("joins the bucket and asks only for bookings in the TEST world when landing on a test bucket", async () => {
      await findActiveBookingsForPerson(
        { externalId: "ext-1", salesforceId: null, email: "lead@example.com", phone: null },
        { isTest: true },
      );
      expect(queriedWorlds).toEqual([[true], [true], [true]]);
      for (const s of selects) expect(s).toContain("buckets!inner(is_test)");
    });

    it("asks only for REAL bookings when landing on a real bucket", async () => {
      await findActiveBookingsForPerson(
        { externalId: "ext-1", salesforceId: "sf-1", email: null, phone: "215 555 0100" },
        { isTest: false },
      );
      expect(queriedWorlds).toEqual([[false], [false], [false], [false], [false]]);
    });

    it("hands back plain booking rows, without the joined bucket riding along", async () => {
      resultByColumn.set("external_id", {
        data: [{ ...booking("bk-1"), buckets: { is_test: true } }],
        error: null,
      });
      const rows = await findActiveBookingsForPerson(
        { externalId: "ext-1", salesforceId: null, email: null, phone: null },
        { isTest: true },
      );
      expect(rows.map((b) => b.id)).toEqual(["bk-1"]);
      expect(rows[0]).not.toHaveProperty("buckets");
    });
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
    }, { isTest: false });

    // bk-1 is returned by both queries and must appear once.
    expect(rows.map((b) => b.id).sort()).toEqual(["bk-1", "bk-2"]);
  });

  it("issues a query per identity signal it was given, each strong id on both id columns", async () => {
    await findActiveBookingsForPerson({
      externalId: "ext-1",
      salesforceId: "sf-1",
      email: "Lead@Example.com",
      phone: "215 555 0100",
    }, { isTest: false });
    expect(queriedPairs.map(([c, v]) => `${c}=${String(v)}`).sort()).toEqual([
      "attendee_email=Lead@Example.com",
      "attendee_phone=+12155550100",
      "external_id=ext-1",
      "external_id=sf-1",
      "salesforce_id=ext-1",
      "salesforce_id=sf-1",
    ]);
  });

  // #2663: an embed booking holds the lead id in salesforce_id with external_id
  // null. A caller sending only externalId must FETCH that row, or the grader
  // never sees it and a second call is booked. Both directions.
  it("reads an externalId against salesforce_id too, so an embed booking is fetched", async () => {
    resultByColumn.set("salesforce_id", { data: [booking("bk-embed")], error: null });
    const rows = await findActiveBookingsForPerson(
      { externalId: "00Q-lead", salesforceId: null, email: null, phone: null },
      { isTest: false },
    );
    expect(queriedPairs).toContainEqual(["salesforce_id", "00Q-lead"]);
    expect(rows.map((b) => b.id)).toEqual(["bk-embed"]);
  });

  it("reads a salesforceId against external_id too", async () => {
    resultByColumn.set("external_id", { data: [booking("bk-api")], error: null });
    const rows = await findActiveBookingsForPerson(
      { externalId: null, salesforceId: "00Q-lead", email: null, phone: null },
      { isTest: false },
    );
    expect(queriedPairs).toContainEqual(["external_id", "00Q-lead"]);
    expect(rows.map((b) => b.id)).toEqual(["bk-api"]);
  });

  it("reads one id given in both fields once per column, not twice", async () => {
    await findActiveBookingsForPerson(
      { externalId: "00Q-lead", salesforceId: " 00Q-lead ", email: null, phone: null },
      { isTest: false },
    );
    expect(queriedPairs.map(([c, v]) => `${c}=${String(v)}`).sort()).toEqual([
      "external_id=00Q-lead",
      "salesforce_id=00Q-lead",
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
      }, { isTest: false }),
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
      }, { isTest: false }),
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
    }, { isTest: false });
    expect(rows).toEqual([]);
  });

  it("returns no bookings without querying when the identity carries no signal", async () => {
    const rows = await findActiveBookingsForPerson({
      externalId: null,
      salesforceId: null,
      email: null,
      phone: null,
    }, { isTest: false });
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
