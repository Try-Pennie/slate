import { describe, it, expect } from "vitest";
import { loadUpcomingBookingsInBuckets, loadCatchallByBooking } from "./below-lead-tier-store";

// #2593. The two reads behind the below-tier check. The fake HONOURS the filters
// rather than asserting a query shape, so a read that forgot one returns the rows
// it should have excluded and fails here: a cancelled booking or a smoke bucket's
// booking reaching the comparison would page about Slate's own canary (L98).

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>, opts: { error?: string } = {}) {
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let range: [number, number] = [0, 999];
      const chain = {
        select: () => chain,
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
          return chain;
        },
        gte: (col: string, val: string) => {
          filters.push((r) => String(r[col]) >= val);
          return chain;
        },
        order: () => chain,
        range: (from: number, to: number) => {
          range = [from, to];
          return chain;
        },
        then: (res: (v: unknown) => unknown) => {
          if (opts.error) return Promise.resolve(res({ data: null, error: { message: opts.error } }));
          const kept = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
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
      ],
    });
    const rows = await loadUpcomingBookingsInBuckets(db, ["real"], NOW);
    expect(rows.map((r) => r.id).sort()).toEqual(["keep", "rescheduled"]);
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

describe("loadCatchallByBooking", () => {
  it("answers per booking, and a booking with no routing decision is simply absent", async () => {
    const db = fakeDb({
      routing_decisions: [
        { booking_id: "bk-1", catchall_applied: true },
        { booking_id: "bk-2", catchall_applied: false },
        { booking_id: "other", catchall_applied: true },
      ],
    });
    const m = await loadCatchallByBooking(db, ["bk-1", "bk-2", "bk-3"]);
    expect(m.get("bk-1")).toBe(true);
    expect(m.get("bk-2")).toBe(false);
    expect(m.has("bk-3")).toBe(false);
    expect(m.has("other")).toBe(false);
  });

  it("THROWS on a read error, so the page says the context could not be read", async () => {
    await expect(loadCatchallByBooking(fakeDb({}, { error: "timeout" }), ["bk-1"])).rejects.toThrow();
  });
});
