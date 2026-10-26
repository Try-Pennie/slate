import { describe, it, expect } from "vitest";
import { loadUpcomingBookingsInBuckets, loadRoutingContextByBooking } from "./below-lead-tier-store";

// #2593. The two reads behind the below-tier check. The fake HONOURS the filters
// rather than asserting a query shape, so a read that forgot one returns the rows
// it should have excluded and fails here: a cancelled booking or a smoke bucket's
// booking reaching the comparison would page about Slate's own canary (L98).

type Row = Record<string, unknown>;

function fakeDb(
  tables: Record<string, Row[]>,
  opts: { error?: string; orders?: [string, string, unknown][] } = {},
) {
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let range: [number, number] = [0, 999];
      // The column list is honoured too, so a read that stops naming a column the
      // check needs hands it undefined here exactly as PostgREST would.
      let columns: string[] | null = null;
      const chain = {
        select: (cols: string) => {
          columns = cols.split(",").map((c) => c.trim());
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
          return chain;
        },
        gte: (col: string, val: string) => {
          filters.push((r) => String(r[col]) >= val);
          return chain;
        },
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return chain;
        },
        // The keyset filter a paged read cuts each later page with.
        gt: (col: string, val: string) => {
          filters.push((r) => String(r[col]) > val);
          return chain;
        },
        // Recorded rather than applied, so a test can ask whether the paged read
        // asked for a stable order at all: without one Postgres may skip or
        // repeat rows across pages.
        order: (col: string, o?: unknown) => {
          opts.orders?.push([table, col, o]);
          return chain;
        },
        range: (from: number, to: number) => {
          range = [from, to];
          return chain;
        },
        then: (res: (v: unknown) => unknown) => {
          if (opts.error) return Promise.resolve(res({ data: null, error: { message: opts.error } }));
          // A fixture row naming no primary key is given one by its position.
          const kept = (tables[table] ?? [])
            .map((r, i): Row => ({ id: `${table}-${i}`, ...r }))
            .filter((r) => filters.every((f) => f(r)))
            .map((r) => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r));
          return Promise.resolve(res({ data: kept.slice(range[0], range[1] + 1), error: null }));
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof loadUpcomingBookingsInBuckets>[0];
}

const NOW = "2026-09-24T14:00:00.000Z";
const LATER = "2026-09-25T15:00:00.000Z";
const EARLIER = "2026-09-23T15:00:00.000Z";

function b(id: string, over: Row = {}): Row {
  return {
    id,
    bucket_id: "real",
    starts_at: LATER,
    status: "confirmed",
    salesforce_id: "00QUi00000zhEUPMA2",
    external_id: null,
    agent_name: "A",
    agent_email: "a@trypennie.com",
    kind: "routed",
    ...over,
  };
}

describe("loadUpcomingBookingsInBuckets", () => {
  it("keeps only upcoming active bookings in the buckets it is given", async () => {
    const db = fakeDb({
      bookings: [
        b("keep"),
        b("rescheduled", { status: "rescheduled" }),
        b("cancelled", { status: "cancelled" }),
        b("completed", { status: "completed" }),
        b("past", { starts_at: EARLIER }),
        b("smoke", { bucket_id: "smoke" }),
        // #2073: booked with the agent the lead already has, never routed below
        // their tier, so it is not the check's to page about.
        b("named", { kind: "agent_link" }),
      ],
    });
    const rows = await loadUpcomingBookingsInBuckets(db, ["real"], NOW);
    expect(rows.map((r) => r.id).sort()).toEqual(["keep", "rescheduled"]);
  });

  it("reads the host page each booking was made from, which is what excludes a test booking (#2737)", async () => {
    const db = fakeDb({ bookings: [b("keep", { prefill: { parentOrigin: "http://localhost:3000" } })] });
    const [row] = await loadUpcomingBookingsInBuckets(db, ["real"], NOW);
    expect(row.prefill).toEqual({ parentOrigin: "http://localhost:3000" });
  });

  it("reads nothing for no buckets", async () => {
    expect(await loadUpcomingBookingsInBuckets(fakeDb({ bookings: [b("x")] }), [], NOW)).toEqual([]);
  });

  it("THROWS on a read error rather than answering an empty roster", async () => {
    await expect(
      loadUpcomingBookingsInBuckets(fakeDb({}, { error: "column does not exist" }), ["real"], NOW),
    ).rejects.toThrow();
  });
});

describe("loadRoutingContextByBooking", () => {
  it("answers per booking, and a booking with no routing decision is simply absent", async () => {
    const db = fakeDb({
      routing_decisions: [
        { booking_id: "bk-1", catchall_applied: true, requested_code: "", tier_fallback: false, rungs_dropped: 0, created_at: EARLIER },
        { booking_id: "bk-2", catchall_applied: false, requested_code: "422", tier_fallback: false, rungs_dropped: 0, created_at: EARLIER },
        { booking_id: "other", catchall_applied: true, requested_code: null, tier_fallback: false, rungs_dropped: 0, created_at: EARLIER },
      ],
    });
    const m = await loadRoutingContextByBooking(db, ["bk-1", "bk-2", "bk-3"]);
    expect(m.get("bk-1")).toEqual({ catchall: true, requestedCode: "", tierFallback: false, rungsDropped: 0 });
    // #2594: the code the lead ARRIVED with, which is what tells a re-score after
    // booking apart from a lead routed below its own code.
    expect(m.get("bk-2")).toEqual({ catchall: false, requestedCode: "422", tierFallback: false, rungsDropped: 0 });
    expect(m.has("bk-3")).toBe(false);
    expect(m.has("other")).toBe(false);
  });

  // 2026-10-02: whether confirm walked down the tier ladder, and how far, is what
  // tells a designed drop from a routing fault, so it is read with the rest and
  // from the same NEWEST decision.
  it("carries the tier drop from the NEWEST decision, whatever order the rows arrive in", async () => {
    const rows = [
      { booking_id: "bk-1", catchall_applied: false, requested_code: "311", tier_fallback: false, rungs_dropped: 0, created_at: EARLIER },
      { booking_id: "bk-1", catchall_applied: false, requested_code: "311", tier_fallback: true, rungs_dropped: 1, created_at: LATER },
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const m = await loadRoutingContextByBooking(fakeDb({ routing_decisions: ordered }), ["bk-1"]);
      expect(m.get("bk-1")).toEqual({ catchall: false, requestedCode: "311", tierFallback: true, rungsDropped: 1 });
    }
  });

  it("takes the arrival code from the NEWEST decision, whatever order the rows arrive in", async () => {
    const rows = [
      { booking_id: "bk-1", catchall_applied: false, requested_code: "211", tier_fallback: false, rungs_dropped: 0, created_at: EARLIER },
      { booking_id: "bk-1", catchall_applied: false, requested_code: "422", tier_fallback: false, rungs_dropped: 0, created_at: LATER },
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const m = await loadRoutingContextByBooking(fakeDb({ routing_decisions: ordered }), ["bk-1"]);
      expect(m.get("bk-1")?.requestedCode).toBe("422");
    }
  });

  it("takes the catch-all flag from the NEWEST decision too, so an older catch-all is not blamed", async () => {
    // An earlier decision fell to the catch-all and a later one routed the lead
    // properly. The call sits where the later one put it, so the page must not
    // say the catch-all chose the pool.
    const rows = [
      { booking_id: "bk-1", catchall_applied: true, requested_code: "", tier_fallback: false, rungs_dropped: 0, created_at: EARLIER },
      { booking_id: "bk-1", catchall_applied: false, requested_code: "422", tier_fallback: false, rungs_dropped: 0, created_at: LATER },
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const m = await loadRoutingContextByBooking(fakeDb({ routing_decisions: ordered }), ["bk-1"]);
      expect(m.get("bk-1")).toEqual({ catchall: false, requestedCode: "422", tierFallback: false, rungsDropped: 0 });
    }
  });

  it("says catch-all when the NEWEST decision was the catch-all, whatever order the rows arrive in", async () => {
    const rows = [
      { booking_id: "bk-1", catchall_applied: false, requested_code: "422", tier_fallback: false, rungs_dropped: 0, created_at: EARLIER },
      { booking_id: "bk-1", catchall_applied: true, requested_code: "", tier_fallback: false, rungs_dropped: 0, created_at: LATER },
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const m = await loadRoutingContextByBooking(fakeDb({ routing_decisions: ordered }), ["bk-1"]);
      expect(m.get("bk-1")).toEqual({ catchall: true, requestedCode: "", tierFallback: false, rungsDropped: 0 });
    }
  });

  it("breaks a tie on created_at by the higher id, whatever order the rows arrive in", async () => {
    const rows = [
      { id: "a1", booking_id: "bk-1", catchall_applied: true, requested_code: "", tier_fallback: false, rungs_dropped: 0, created_at: LATER },
      { id: "b2", booking_id: "bk-1", catchall_applied: false, requested_code: "422", tier_fallback: false, rungs_dropped: 0, created_at: LATER },
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const m = await loadRoutingContextByBooking(fakeDb({ routing_decisions: ordered }), ["bk-1"]);
      expect(m.get("bk-1")).toEqual({ catchall: false, requestedCode: "422", tierFallback: false, rungsDropped: 0 });
    }
  });

  it("pages by its unique key alone, so no row is skipped or repeated across pages", async () => {
    // Keyset paging (2026-10-25): each page is the rows after the last id seen, so
    // the read asks for no other order; the newest decision is chosen by created_at
    // in code, whatever order the rows arrive in (the cases above).
    const orders: [string, string, unknown][] = [];
    await loadRoutingContextByBooking(fakeDb({ routing_decisions: [] }, { orders }), ["bk-1"]);
    expect(orders.map(([t, c]) => [t, c])).toEqual([["routing_decisions", "id"]]);
  });

  it("THROWS on a read error, so the page says the context could not be read", async () => {
    await expect(loadRoutingContextByBooking(fakeDb({}, { error: "timeout" }), ["bk-1"])).rejects.toThrow();
  });
});
