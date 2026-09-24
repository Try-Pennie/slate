import { describe, it, expect, vi, beforeEach } from "vitest";

// #1046: the admin booking lookup's text search used to interpolate the raw query
// straight into a PostgREST `.or()` filter string:
//
//   .or(`attendee_email.ilike.%${q}%,attendee_name.ilike.%${q}%,...`)
//
// PostgREST parses that string as grammar, so a comma or a parenthesis in the
// query injected extra OR clauses or broke the parse (a legitimate search for
// "Doe, Jane" simply errored), and `%`/`_` acted as wildcards rather than as the
// characters the person typed. Tenant scoping was never at risk (the org filter is
// a separately ANDed `.eq`), so the blast radius was inside the caller's own org,
// but a filter string assembled from user text is not a thing to leave standing.
//
// The fix is the shape `service.ts` already uses for the person lookup: one
// `.ilike()` per column, each value escaped, merged in memory. supabase-js encodes
// a single filter value itself, so there is no grammar left to inject into.
//
// These tests drive the REAL default deps against a recording fake, because the
// defect lived entirely in the query construction: every test that goes through an
// injected `byText` seam passes just as happily with the vulnerable string.

interface RecordedQuery {
  table: string;
  select?: string;
  eq: [string, unknown][];
  ilike: [string, string][];
  or: string[];
  order: [string, unknown][];
  limit?: number;
}

const state = vi.hoisted(() => ({
  queries: [] as RecordedQuery[],
  /** Rows each ilike'd column resolves, keyed by column. */
  rowsByColumn: new Map<string, unknown[]>(),
  usersRows: [] as unknown[],
}));

const from = vi.hoisted(() => {
  return vi.fn((table: string) => {
    const q: RecordedQuery = { table, eq: [], ilike: [], or: [], order: [] };
    state.queries.push(q);
    const builder: Record<string, unknown> = {
      select: (cols: string) => {
        q.select = cols;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        q.eq.push([col, val]);
        return builder;
      },
      in: (col: string, val: unknown) => {
        q.eq.push([col, val]);
        return builder;
      },
      ilike: (col: string, pattern: string) => {
        q.ilike.push([col, pattern]);
        return builder;
      },
      or: (filter: string) => {
        q.or.push(filter);
        return builder;
      },
      order: (col: string, opts: unknown) => {
        q.order.push([col, opts]);
        return builder;
      },
      limit: (n: number) => {
        q.limit = n;
        return builder;
      },
      maybeSingle: () => builder,
      // The builder is awaited directly, exactly as supabase-js's thenable is.
      then: (resolve: (r: { data: unknown; error: null }) => unknown) => {
        const data =
          q.table === "users"
            ? state.usersRows
            : q.ilike.length
              ? (state.rowsByColumn.get(q.ilike[0]![0]) ?? [])
              : [];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return builder;
  });
});

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import { searchBookings, textSearchPattern, SEARCH_LIMIT } from "./search";

function booking(id: string, startsAt: string) {
  return {
    id,
    attendee_name: "Jane Doe",
    attendee_email: "jane@acme.co",
    attendee_phone: "+15555550100",
    starts_at: startsAt,
    assigned_user_id: null,
    status: "confirmed",
  };
}

beforeEach(() => {
  state.queries.length = 0;
  state.rowsByColumn.clear();
  state.usersRows = [];
  vi.clearAllMocks();
});

describe("textSearchPattern", () => {
  it("matches the query literally, wrapped for a substring search", () => {
    expect(textSearchPattern("jane")).toBe("%jane%");
  });

  it("escapes the ILIKE wildcards so a typed character is not a wildcard", () => {
    // `john_doe@` must not also match `johnXdoe@`, and a lone `%` must not match
    // every booking in the org.
    expect(textSearchPattern("john_doe")).toBe("%john\\_doe%");
    expect(textSearchPattern("%")).toBe("%\\%%");
    // The escape character itself is escaped first, so it cannot re-escape the
    // backslashes added for `_` and `%`.
    expect(textSearchPattern("a\\_b")).toBe("%a\\\\\\_b%");
  });

  it("leaves PostgREST filter-grammar characters alone (they are values now)", () => {
    // These are exactly the characters that used to break or widen the `.or()`
    // string. They are no longer parsed as grammar, so they must reach ILIKE
    // untouched rather than being stripped from what the person searched for.
    expect(textSearchPattern("Doe, Jane")).toBe("%Doe, Jane%");
    expect(textSearchPattern('a(b)"c')).toBe('%a(b)"c%');
  });
});

// #2660: a stranger's booking on the public test bucket is searchable here like
// any lead's (decision: visible, marked, rather than hidden), so each row says
// which world it is in, read off the bucket through the same inner join the
// monitors use. `bookings` has no flag of its own.
describe("booking lookup marks test bookings (#2660)", () => {
  it("joins the bucket on every bookings read, text and id alike", async () => {
    await searchBookings("org-1", "jane");
    await searchBookings("org-1", "9b2e5c7a-1c1d-4f0e-9a1e-2f3c4d5e6f70");
    const bookingQueries = state.queries.filter((q) => q.table === "bookings");
    expect(bookingQueries.length).toBe(4);
    for (const q of bookingQueries) expect(q.select).toContain("buckets!inner(is_test)");
  });

  it("carries the bucket's flag onto each row, true for a test bucket and false for a real one", async () => {
    state.rowsByColumn.set("attendee_email", [
      { ...booking("b-test", "2026-07-02T18:00:00Z"), buckets: { is_test: true } },
      { ...booking("b-real", "2026-07-01T18:00:00Z"), buckets: { is_test: false } },
    ]);
    const { rows } = await searchBookings("org-1", "jane");
    expect(rows.map((r) => [r.id, r.isTest])).toEqual([
      ["b-test", true],
      ["b-real", false],
    ]);
  });
});

describe("booking lookup text search query shape", () => {
  it("never builds a PostgREST or() filter string from the query", async () => {
    await searchBookings("org-1", "Doe, Jane");

    const bookingQueries = state.queries.filter((q) => q.table === "bookings");
    expect(bookingQueries.length).toBeGreaterThan(0);
    for (const q of bookingQueries) expect(q.or).toEqual([]);
  });

  it("issues one escaped, org-scoped, bounded ilike per searched column", async () => {
    await searchBookings("org-1", "john_doe");

    const bookingQueries = state.queries.filter((q) => q.table === "bookings");
    expect(bookingQueries.map((q) => q.ilike[0]?.[0])).toEqual([
      "attendee_email",
      "attendee_name",
      "attendee_phone",
    ]);
    for (const q of bookingQueries) {
      // One filter per query: a second ilike on the same query would AND, not OR.
      expect(q.ilike).toHaveLength(1);
      expect(q.ilike[0]?.[1]).toBe("%john\\_doe%");
      // Tenant scoping survives the split. This is the assertion that matters
      // most: three queries mean three places the org filter could go missing.
      expect(q.eq).toContainEqual(["org_id", "org-1"]);
      // Bounded, so the growth-table read stays cap-safe.
      expect(q.limit).toBe(SEARCH_LIMIT);
      expect(q.order).toContainEqual(["starts_at", { ascending: false }]);
    }
  });

  it("merges the columns' rows, newest first, deduplicated by id", async () => {
    // b2 matches on two columns; it must appear once.
    state.rowsByColumn.set("attendee_email", [
      booking("b2", "2026-07-02T18:00:00Z"),
      booking("b3", "2026-07-01T18:00:00Z"),
    ]);
    state.rowsByColumn.set("attendee_name", [booking("b2", "2026-07-02T18:00:00Z")]);
    state.rowsByColumn.set("attendee_phone", [booking("b1", "2026-07-03T18:00:00Z")]);

    const res = await searchBookings("org-1", "jane");

    expect(res.rows.map((r) => r.id)).toEqual(["b1", "b2", "b3"]);
    expect(res.truncated).toBe(false);
  });

  it("still reports truncation when the merged result fills the bound", async () => {
    // #903: the person needs to know they are not seeing everything. Filling the
    // bound is the signal, and it survives the split: the global newest-N is a
    // subset of the union of each column's newest-N, so a union short of the bound
    // really is every match.
    const rows = Array.from({ length: SEARCH_LIMIT }, (_, i) =>
      booking(`b${i}`, `2026-07-${String(i + 1).padStart(2, "0")}T18:00:00Z`),
    );
    state.rowsByColumn.set("attendee_email", rows);

    const res = await searchBookings("org-1", "jane");

    expect(res.rows).toHaveLength(SEARCH_LIMIT);
    expect(res.truncated).toBe(true);
  });

  it("routes a UUID query to the exact id lookup, with no ilike at all", async () => {
    await searchBookings("org-1", "ad24625e-31da-4b94-85c0-9a4f9ca71200");

    const bookingQueries = state.queries.filter((q) => q.table === "bookings");
    expect(bookingQueries).toHaveLength(1);
    expect(bookingQueries[0]!.ilike).toEqual([]);
    expect(bookingQueries[0]!.eq).toContainEqual(["org_id", "org-1"]);
    expect(bookingQueries[0]!.eq).toContainEqual([
      "id",
      "ad24625e-31da-4b94-85c0-9a4f9ca71200",
    ]);
  });
});
