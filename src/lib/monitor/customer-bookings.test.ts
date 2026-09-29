import { describe, it, expect, vi } from "vitest";

// #1258: the low-volume alarm's input. It exists to notice that customers have
// stopped booking, so the one thing it must never count is Slate booking against
// itself: the smoke canary makes roughly 8 bookings every 6 hours forever, and a
// floor measured against those cannot tell a quiet afternoon from a dead funnel.
//
// `bookings` has no is_test column of its own, so a booking is a test booking when
// its BUCKET is one (the SMOKE fixtures, #396). The fake below therefore honours
// the embedded filter rather than asserting against a shape of its own: what the
// query asks for is what decides the count.

import {
  countCustomerBookingsSince,
  customerBookingFromSourcesSince,
  firstTierBookingsSince,
  listCustomerBookingSourcesSince,
  measurePageSources,
  SOURCE_READ_LIMIT,
} from "./customer-bookings";

import { API_SOURCES } from "@/lib/booking/booking-source";

const SINCE = "2026-08-05T09:00:00.000Z";

/** A `like` on the embedded bucket code: only a trailing `%` is honoured, and the row's code defaults to a Low one. */
function likePredicate(col: string, pattern: string): (r: { code?: string }) => boolean {
  if (col !== "buckets.code" || !/^[^%]*%$/.test(pattern)) throw new Error(`fake: unhandled like(${col}, ${pattern})`);
  const prefix = pattern.slice(0, -1);
  return (r) => (r.code ?? "111").startsWith(prefix);
}

/**
 * The `or()` alternatives these reads send, and nothing else: `source.is.null`,
 * `source.eq.<v>` and `source.not.in.(<a>,<b>)`. Anything else throws, so a new
 * filter cannot pass through a fake that never read it.
 */
function orPredicate(expr: string): (r: { source?: string | null }) => boolean {
  const alts: ((r: { source?: string | null }) => boolean)[] = [];
  const notIn = /source\.not\.in\.\(([^)]*)\)/g;
  const rest = expr.replace(notIn, (_all, list: string) => {
    const vals = list.split(",");
    alts.push((r) => r.source != null && !vals.includes(r.source));
    return "";
  });
  for (const a of rest.split(",").filter(Boolean)) {
    if (a === "source.is.null") {
      alts.push((r) => (r.source ?? null) === null);
      continue;
    }
    const m = /^source\.eq\.(.+)$/.exec(a);
    if (!m) throw new Error(`fake: unhandled or() alternative ${a}`);
    alts.push((r) => r.source === m[1]);
  }
  return (r) => alts.some((f) => f(r));
}

/**
 * A stand-in for the supabase count chain. Records the filters applied and
 * resolves the count from rows the filters actually select, so a query missing the
 * is_test filter counts the canary rows and fails the test.
 */
function fakeDb(
  rows: { created_at: string; is_test: boolean; kind?: string; source?: string | null; code?: string }[],
  opts: { error?: string } = {},
) {
  const filters: { col: string; val: unknown }[] = [];
  const ors: ((r: { source?: string | null; code?: string }) => boolean)[] = [];
  const chain = {
    select: (_cols: string, _opts: { count: string; head: boolean }) => chain,
    or: (expr: string) => (ors.push(orPredicate(expr)), chain),
    like: (col: string, pattern: string) => (ors.push(likePredicate(col, pattern)), chain),
    eq: (col: string, val: unknown) => {
      filters.push({ col, val });
      return chain;
    },
    gte: (col: string, val: unknown) => {
      filters.push({ col, val });
      return chain;
    },
    then: (res: (v: unknown) => unknown) => {
      if (opts.error) {
        return Promise.resolve(res({ count: null, error: { message: opts.error } }));
      }
      const testFilter = filters.find((f) => f.col === "buckets.is_test");
      // #2073: honoured like the test filter, so a count that forgot it counts
      // the named link bookings below.
      const kindFilter = filters.find((f) => f.col === "kind");
      const since = filters.find((f) => f.col === "created_at")?.val as string | undefined;
      const kept = rows.filter(
        (r) =>
          ors.every((o) => o(r)) &&
          (since === undefined || r.created_at >= since) &&
          (testFilter === undefined || r.is_test === testFilter.val) &&
          (kindFilter === undefined || (r.kind ?? "routed") === kindFilter.val),
      );
      return Promise.resolve(res({ count: kept.length, error: null }));
    },
  };
  return {
    filters,
    // Each query starts clean, so two reads on one fake never share filters; the
    // filters left are the last query's.
    db: {
      from: (_t: string) => {
        filters.length = 0;
        ors.length = 0;
        return chain;
      },
    } as never,
  };
}

const canary = (created_at: string) => ({ created_at, is_test: true });
const customer = (created_at: string) => ({ created_at, is_test: false });

describe("countCustomerBookingsSince", () => {
  it("counts customer bookings and ignores the canary's", async () => {
    const { db } = fakeDb([
      canary("2026-08-05T10:00:00.000Z"),
      canary("2026-08-05T10:05:00.000Z"),
      canary("2026-08-05T11:00:00.000Z"),
      customer("2026-08-05T10:30:00.000Z"),
    ]);
    expect(await countCustomerBookingsSince(db, SINCE, "1")).toBe(1);
  });

  it("returns zero, not the canary's count, on a genuinely dead funnel", async () => {
    // The case the alarm exists for: today's production reality is 8 canary
    // bookings in 6 hours and no customer bookings at all. That has to read as 0.
    const { db } = fakeDb([canary("2026-08-05T10:00:00.000Z"), canary("2026-08-05T12:00:00.000Z")]);
    expect(await countCustomerBookingsSince(db, SINCE, "1")).toBe(0);
  });

  it("does not count a booking made through an agent's own link (#2073)", async () => {
    // A later call with a lead the funnel already sent: counting it would hold the
    // alarm quiet while customers stopped arriving.
    const { db } = fakeDb([
      customer("2026-08-05T10:00:00.000Z"),
      { ...customer("2026-08-05T11:00:00.000Z"), kind: "agent_link" },
    ]);
    expect(await countCustomerBookingsSince(db, SINCE, "1")).toBe(1);
  });

  // #2876: a booking made through the booking API names its caller and came from no
  // landing page. The tier floors were fitted to page traffic (the cal.com routing
  // forms), so a steady API stream counted here would hold the tier above its floor
  // while every landing page was dark.
  it("does not count booking API bookings, so an API stream cannot hold the tier above its floor", async () => {
    const api = Array.from({ length: 30 }, (_, i) => ({
      ...customer(`2026-08-05T10:${String(i).padStart(2, "0")}:00.000Z`),
      source: API_SOURCES[i % API_SOURCES.length]!,
    }));
    const { db } = fakeDb(api);
    expect(await countCustomerBookingsSince(db, SINCE, "1")).toBe(0);
  });

  it("control: page bookings, untagged ones and ones from before sources still count", async () => {
    const { db } = fakeDb([
      { ...customer("2026-08-05T10:00:00.000Z"), source: "offerhub" },
      { ...customer("2026-08-05T10:01:00.000Z"), source: "not-given" },
      { ...customer("2026-08-05T10:02:00.000Z"), source: null },
      { ...customer("2026-08-05T10:03:00.000Z"), source: "unrecognised" },
      { ...customer("2026-08-05T10:04:00.000Z"), source: "api-regal" },
    ]);
    expect(await countCustomerBookingsSince(db, SINCE, "1")).toBe(4);
  });

  // #2874: every floor is scoped to one tier, so a count for one tier must never
  // include another's bookings, or widening the pilot moves the Low alarm.
  it("counts only the tier it was asked for", async () => {
    const { db } = fakeDb([
      { ...customer("2026-08-05T10:00:00.000Z"), code: "111" },
      { ...customer("2026-08-05T10:01:00.000Z"), code: "311" },
      { ...customer("2026-08-05T10:02:00.000Z"), code: "312" },
    ]);
    expect(await countCustomerBookingsSince(db, SINCE, "1")).toBe(1);
    // Control: the other tier's bookings are there, and count for their own tier.
    expect(await countCustomerBookingsSince(db, SINCE, "3")).toBe(2);
    expect(await countCustomerBookingsSince(db, SINCE, "5")).toBe(0);
  });

  it("still honours the window it was asked for", async () => {
    const { db } = fakeDb([
      customer("2026-08-05T08:00:00.000Z"), // before SINCE
      customer("2026-08-05T10:00:00.000Z"),
    ]);
    expect(await countCustomerBookingsSince(db, SINCE, "1")).toBe(1);
  });

  it("returns null on a read error, so a failed query never pages a false drought", async () => {
    // The #1158 contract: null means unverified. A read error must NEVER become a
    // zero, because zero is the exact value that pages.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb([customer("2026-08-05T10:00:00.000Z")], { error: "read timeout" });
    expect(await countCustomerBookingsSince(db, SINCE, "1")).toBeNull();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

// #2738: the per page alarm's two reads. The same test-bucket rule applies, and
// both must THROW on a failed read rather than answer, because their empty answers
// ("no bookings from any page", "this page has never recorded a booking") are the
// answers that page.
type SourceFakeRow = { created_at: string; is_test: boolean; source: string | null; code?: string; kind?: string };

function sourceDb(rows: SourceFakeRow[], opts: { error?: string } = {}) {
  const make = () => {
    const filters: { col: string; val: unknown }[] = [];
    const ors: ((r: SourceFakeRow) => boolean)[] = [];
    let limit = Infinity;
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => (filters.push({ col, val }), chain),
      gte: (col: string, val: unknown) => (filters.push({ col, val }), chain),
      in: (col: string, val: unknown) => (filters.push({ col, val }), chain),
      or: (expr: string) => (ors.push(orPredicate(expr)), chain),
      like: (col: string, pattern: string) => (ors.push(likePredicate(col, pattern)), chain),
      order: (col: string, o: { ascending: boolean }) => {
        if (col !== "created_at" || !o.ascending) throw new Error(`fake: unhandled order(${col})`);
        return chain;
      },
      limit: (n: number) => ((limit = n), chain),
      then: (res: (v: unknown) => unknown) => {
        if (opts.error) return Promise.resolve(res({ data: null, count: null, error: { message: opts.error } }));
        const kept = rows.filter((r) => ors.every((o) => o(r))).filter((r) =>
          filters.every((f) =>
            f.col === "buckets.is_test"
              ? r.is_test === f.val
              : f.col === "created_at"
                ? r.created_at >= (f.val as string)
                : f.col === "source"
                  ? (f.val as string[]).includes(r.source ?? "")
                  : f.col === "kind"
                    ? (r.kind ?? "routed") === f.val
                    : true,
          ),
        );
        kept.sort((a, b) => a.created_at.localeCompare(b.created_at));
        const page = kept.slice(0, limit);
        return Promise.resolve(
          res({ data: page.map(({ created_at, source }) => ({ created_at, source })), count: kept.length, error: null }),
        );
      },
    };
    return chain;
  };
  return { db: { from: (_t: string) => make() } as never };
}

describe("listCustomerBookingSourcesSince", () => {
  it("lists customer bookings with their source, leaving the canary's out", async () => {
    const { db } = sourceDb([
      { created_at: "2026-08-05T10:00:00.000Z", is_test: true, source: "offerhub" },
      { created_at: "2026-08-05T10:05:00.000Z", is_test: false, source: "offerhub" },
      { created_at: "2026-08-05T10:06:00.000Z", is_test: false, source: null },
      { created_at: "2026-08-05T08:00:00.000Z", is_test: false, source: "booking" },
    ]);
    expect(await listCustomerBookingSourcesSince(db, SINCE, "1")).toEqual([
      { createdMs: Date.parse("2026-08-05T10:05:00.000Z"), source: "offerhub" },
      { createdMs: Date.parse("2026-08-05T10:06:00.000Z"), source: null },
    ]);
  });

  it("throws on a read error, never answering with an empty list", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = sourceDb([], { error: "read timeout" });
    await expect(listCustomerBookingSourcesSince(db, SINCE, "1")).rejects.toThrow(/could not read/);
    log.mockRestore();
  });

  it("throws on a full page, because a truncated list undercounts every page", async () => {
    const rows = Array.from({ length: SOURCE_READ_LIMIT }, (_, i) => ({
      created_at: new Date(Date.parse(SINCE) + i * 1000).toISOString(),
      is_test: false,
      source: "offerhub",
    }));
    const { db } = sourceDb(rows);
    await expect(listCustomerBookingSourcesSince(db, SINCE, "1")).rejects.toThrow(/truncated/);
  });

  it("throws on a timestamp it cannot read rather than dropping the booking", async () => {
    const { db } = sourceDb([{ created_at: "not a date", is_test: false, source: "offerhub" }]);
    await expect(listCustomerBookingSourcesSince(db, "", "1")).rejects.toThrow(/unreadable/);
  });
});

describe("the per page reads are scoped to a tier (#2874)", () => {
  it("lists and finds only the tier asked for", async () => {
    const { db } = sourceDb([
      { created_at: "2026-08-05T10:05:00.000Z", is_test: false, source: "offerhub", code: "111" },
      { created_at: "2026-08-05T10:06:00.000Z", is_test: false, source: "offerhub", code: "411" },
    ]);
    expect((await listCustomerBookingSourcesSince(db, SINCE, "1")).length).toBe(1);
    expect((await listCustomerBookingSourcesSince(db, SINCE, "4")).length).toBe(1);
    expect(await customerBookingFromSourcesSince(db, ["offerhub"], SINCE, "2")).toBe(false);
    expect(await customerBookingFromSourcesSince(db, ["offerhub"], SINCE, "4")).toBe(true);
  });
});

describe("firstTierBookingsSince (#2874)", () => {
  it("finds each tier's first real page booking, and null for a tier nobody has booked", async () => {
    const { db } = sourceDb([
      { created_at: "2026-10-02T10:00:00.000Z", is_test: false, source: "booking", code: "111" },
      { created_at: "2026-10-01T09:00:00.000Z", is_test: false, source: "offerhub", code: "112" },
      // Not a tier's first real booking, each for its own reason:
      { created_at: "2026-09-30T09:00:00.000Z", is_test: true, source: "booking", code: "311" }, // a test bucket
      { created_at: "2026-09-30T09:01:00.000Z", is_test: false, source: "api-regal", code: "311" }, // not page traffic
      { created_at: "2026-09-30T09:02:00.000Z", is_test: false, source: null, code: "311", kind: "agent_link" }, // not routed
      { created_at: "2026-09-20T09:00:00.000Z", is_test: false, source: "booking", code: "511" }, // before the window
      { created_at: "2026-10-03T12:00:00.000Z", is_test: false, source: "not-given", code: "311" },
    ]);
    const first = await firstTierBookingsSince(db, "2026-09-25T04:00:00.000Z");
    expect(first).toEqual({
      "1": Date.parse("2026-10-01T09:00:00.000Z"),
      "2": null,
      "3": Date.parse("2026-10-03T12:00:00.000Z"),
      "4": null,
      "5": null,
    });
  });

  it("throws on a failed read, never answering that no tier is carried", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = sourceDb([], { error: "read timeout" });
    await expect(firstTierBookingsSince(db, SINCE)).rejects.toThrow(/could not read/);
    log.mockRestore();
  });
});

describe("customerBookingFromSourcesSince", () => {
  it("answers whether any customer booking carried one of the sources", async () => {
    const { db } = sourceDb([
      { created_at: "2026-08-05T10:00:00.000Z", is_test: true, source: "offerhub" },
      { created_at: "2026-08-05T10:00:00.000Z", is_test: false, source: "booking" },
    ]);
    expect(await customerBookingFromSourcesSince(db, ["offerhub", "booking-portal"], SINCE, "1")).toBe(false);
    expect(await customerBookingFromSourcesSince(db, ["booking"], SINCE, "1")).toBe(true);
  });

  it("throws on a read error, so a failure is never 'this page has recorded nothing'", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = sourceDb([], { error: "read timeout" });
    await expect(customerBookingFromSourcesSince(db, ["offerhub"], SINCE, "1")).rejects.toThrow(/could not read/);
    log.mockRestore();
  });
});

// #2876: the measurement the alerts settings page and the readiness gate read. A
// booking made through the booking API names its caller, not a page, so it is not
// page traffic: it neither counts as unsourced nor as a booking the pages could
// have sent. Without that, a lookback holding only API bookings would read as
// "every booking carried a source" and show the page floors as coverage.
describe("measurePageSources", () => {
  const NOW = Date.parse("2026-08-06T09:00:00.000Z");
  const at = "2026-08-05T10:00:00.000Z";
  const row = (source: string | null, is_test = false): SourceFakeRow => ({ created_at: at, is_test, source });

  it("leaves booking API bookings out of both the page traffic and the unsourced count", async () => {
    const { db } = sourceDb([
      row("offerhub"),
      row("not-given"),
      row(null),
      row("api-regal"),
      row("api-trypennie"),
      row("api-canary"),
      row("offerhub", true),
    ]);
    const m = await measurePageSources(db, NOW);
    expect(m.realBookings).toBe(3);
    expect(m.unsourced).toBe(2);
  });

  it("reads a lookback holding only API bookings as no page traffic at all, never as sources recorded", async () => {
    const { db } = sourceDb([row("api-regal"), row("api-trypennie")]);
    const m = await measurePageSources(db, NOW);
    expect(m.realBookings).toBe(0);
    expect(m.unsourced).toBe(0);
    expect(m.pages.every((p) => !p.recorded)).toBe(true);
  });

  it("measures the Low tier only, the tier the page floors describe (#2874)", async () => {
    const { db } = sourceDb([
      { ...row("offerhub"), code: "111" },
      { ...row("not-given"), code: "311" },
      { ...row("not-given"), code: "411" },
    ]);
    const m = await measurePageSources(db, NOW);
    expect(m.realBookings).toBe(1);
    expect(m.unsourced).toBe(0);
  });

  it("asks only about the pages Slate carries, so a page held off it is never reported as silent (#2878)", async () => {
    const { db } = sourceDb([row("booking"), row("booking-agent-eligible")]);
    const m = await measurePageSources(db, NOW);
    expect(m.pages.map((p) => p.id)).toEqual(["application-review-follow-up", "application-review"]);
    expect(m.pages.every((p) => p.recorded)).toBe(true);
    // The pages Slate carries both recorded a booking, so nothing names Income
    // Verification as a page that recorded none, though it recorded nothing.
    expect(m.pages.some((p) => p.id === "income-verification")).toBe(false);
  });

  it("throws on a failed read rather than answering zero", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = sourceDb([], { error: "read timeout" });
    await expect(measurePageSources(db, NOW)).rejects.toThrow(/could not be read/);
    log.mockRestore();
  });
});
