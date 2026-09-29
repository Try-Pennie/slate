import { describe, it, expect, vi } from "vitest";
import { listBookingStampsBetween } from "./volume-learning-bookings";
import { isPageTraffic, pageTrafficFilter } from "./page-volume";

// #2739: the read the low volume learner is fitted from.
const SINCE = "2026-08-05T09:00:00.000Z";

/**
 * A paging fake for the learner's read (#2739): honours gte/lt on created_at,
 * order and range, and returns the embedded bucket rather than filtering on it, so
 * a query that filtered test bookings out server side would lose the count the
 * learner reports.
 */
function stampDb(
  rows: { created_at: string; is_test: boolean; source?: string | null }[],
  opts: { errorOnPage?: number } = {},
) {
  const pages: [number, number][] = [];
  const make = () => {
    const f: { gte?: string; lt?: string; eqTest?: unknown; or?: string } = {};
    const chain = {
      select: (_c: string) => chain,
      // Only the page traffic filter (#2876) is understood; anything else throws.
      or: (expr: string) => {
        if (expr !== pageTrafficFilter()) throw new Error(`fake: unhandled or() ${expr}`);
        f.or = expr;
        return chain;
      },
      eq: (col: string, val: unknown) => {
        if (col === "buckets.is_test") f.eqTest = val;
        return chain;
      },
      gte: (_c: string, v: string) => ((f.gte = v), chain),
      lt: (_c: string, v: string) => ((f.lt = v), chain),
      order: () => chain,
      range: (from: number, to: number) => {
        pages.push([from, to]);
        const index = pages.length - 1;
        const kept = rows
          .filter((r) => (f.gte === undefined || r.created_at >= f.gte) && (f.lt === undefined || r.created_at < f.lt))
          .filter((r) => f.eqTest === undefined || r.is_test === f.eqTest)
          .filter((r) => f.or === undefined || isPageTraffic(r.source ?? null))
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .slice(from, to + 1)
          .map((r) => ({ created_at: r.created_at, buckets: { is_test: r.is_test } }));
        return Promise.resolve(
          opts.errorOnPage === index ? { data: null, error: { message: "read timeout" } } : { data: kept, error: null },
        );
      },
    };
    return chain;
  };
  return { pages, db: { from: (_t: string) => make() } as never };
}

describe("listBookingStampsBetween", () => {
  const UNTIL = "2026-08-06T09:00:00.000Z";

  it("reads every booking in the window, test ones flagged rather than dropped", async () => {
    const { db } = stampDb([
      { created_at: "2026-08-05T08:59:00.000Z", is_test: false },
      { created_at: "2026-08-05T10:00:00.000Z", is_test: true },
      { created_at: "2026-08-05T10:05:00.000Z", is_test: false },
      { created_at: UNTIL, is_test: false },
    ]);
    expect(await listBookingStampsBetween(db, SINCE, UNTIL)).toEqual([
      { createdAtMs: Date.parse("2026-08-05T10:00:00.000Z"), isTest: true },
      { createdAtMs: Date.parse("2026-08-05T10:05:00.000Z"), isTest: false },
    ]);
  });

  // #2876: the floors are learned from the population the tier alarm counts, which
  // is page traffic. A booking API call learned as traffic would raise the floors
  // above anything the pages alone send, and the alarm would page a healthy day.
  it("learns from page traffic only, leaving booking API bookings out", async () => {
    const { db } = stampDb([
      { created_at: "2026-08-05T10:00:00.000Z", is_test: false, source: "api-regal" },
      { created_at: "2026-08-05T10:01:00.000Z", is_test: false, source: "api-trypennie" },
      { created_at: "2026-08-05T10:02:00.000Z", is_test: false, source: "offerhub" },
      { created_at: "2026-08-05T10:03:00.000Z", is_test: false, source: null },
    ]);
    expect(await listBookingStampsBetween(db, SINCE, UNTIL)).toEqual([
      { createdAtMs: Date.parse("2026-08-05T10:02:00.000Z"), isTest: false },
      { createdAtMs: Date.parse("2026-08-05T10:03:00.000Z"), isTest: false },
    ]);
  });

  it("pages past PostgREST's 1,000 rows rather than learning from the first page", async () => {
    const rows = Array.from({ length: 2_345 }, (_, i) => ({
      created_at: new Date(Date.parse(SINCE) + i * 1000).toISOString(),
      is_test: false,
    }));
    const { db, pages } = stampDb(rows);
    expect((await listBookingStampsBetween(db, SINCE, UNTIL)).length).toBe(2_345);
    expect(pages.length).toBe(3);
  });

  it("throws when a later page fails, never answering with the pages it got", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = Array.from({ length: 1_500 }, (_, i) => ({
      created_at: new Date(Date.parse(SINCE) + i * 1000).toISOString(),
      is_test: false,
    }));
    const { db } = stampDb(rows, { errorOnPage: 1 });
    await expect(listBookingStampsBetween(db, SINCE, UNTIL)).rejects.toThrow(/read failed/);
    log.mockRestore();
  });

  it("throws on a timestamp it cannot read rather than dropping the booking", async () => {
    const { db } = stampDb([{ created_at: "not a date", is_test: false }]);
    await expect(listBookingStampsBetween(db, "", "~")).rejects.toThrow(/unreadable/);
  });
});
