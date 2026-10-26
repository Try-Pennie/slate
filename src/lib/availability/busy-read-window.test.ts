import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import type { Bucket, EventType } from "@/lib/db/types";

// #3273: two ways the cached busy time could disagree with the live check at confirm.
//
// 1. The confirm candidate read loaded busy_blocks over the RAW call window, while the
//    slot rule and verify on book judge the 10 before and 10 after buffers. A meeting
//    ending exactly at the start (or starting exactly at the end) sits only inside a
//    buffer, so it was never read, the advisor read as free, and live Google refused
//    them. On 2026-10-04 that cost 7.4s across 15 advisors before a 409.
//
// 2. The busy read pages past PostgREST's 1,000 row cap with OFFSET and no ORDER BY,
//    so each page is free to come back in its own order: measured against production
//    on 2026-10-05, a 43 advisor pool read 2,392 rows of which only 1,826 were
//    distinct. The rows it skipped made six advisors read as free at a time every one
//    of them was booked, which is how a sold out Monday kept being offered.
//
// The fake below honours the filters (so a read over the wrong window really misses a
// row) and, like Postgres, owes no row order to a query that asks for none: an
// unordered page comes back reversed on every other call.

const dbHolder = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof supabaseAdmin> }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => dbHolder.db }));

import { roundRobinCandidates, loadMembersAvailability } from "./service";

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>): ReturnType<typeof supabaseAdmin> {
  const unorderedCalls = new Map<string, number>();
  const builder = (table: string, all: Row[]) => {
    const filters: ((r: Row) => boolean)[] = [];
    let orderCol: string | null = null;
    let range: [number, number] | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      lt: (c: string, v: string) => (filters.push((r) => Date.parse(String(r[c])) < Date.parse(v)), b),
      // A time column compares as instants; the key (the keyset filter each later
      // page is cut with, 2026-10-25) compares as text, as Postgres compares it.
      gt: (c: string, v: string) =>
        (filters.push((r) => (c === "id" ? String(r[c]) > v : Date.parse(String(r[c])) > Date.parse(v))), b),
      gte: () => b,
      lte: () => b,
      is: () => b,
      limit: () => b,
      order: (c: string) => ((orderCol = c), b),
      range: (from: number, to: number) => ((range = [from, to]), b),
      maybeSingle: () => Promise.resolve({ data: all[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
        let rows = all.filter((r) => filters.every((f) => f(r)));
        if (orderCol) {
          const c = orderCol;
          rows = [...rows].sort((x, y) => String(x[c]).localeCompare(String(y[c])));
        } else {
          const n = unorderedCalls.get(table) ?? 0;
          unorderedCalls.set(table, n + 1);
          if (n % 2 === 1) rows = [...rows].reverse();
        }
        const data = range ? rows.slice(range[0], range[1] + 1) : rows.slice(0, 1000);
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return b;
  };
  return {
    from: (t: string) => builder(t, tables[t] ?? []),
    rpc: (name: string) =>
      Promise.resolve({ data: name === "live_reroute_holds" ? [] : {}, error: null }),
  } as unknown as ReturnType<typeof supabaseAdmin>;
}

const BUCKET = {
  id: "b1",
  org_id: "org1",
  code: "312",
  name: "High",
  criteria: {},
  fallback_user_id: null,
  is_test: false,
} as unknown as Bucket;

// Production's event type since 2026-10-02: twenty minutes, ten either side.
const EVENT_TYPE = {
  id: "e1",
  duration_min: 20,
  buffer_before_min: 10,
  buffer_after_min: 10,
  min_notice_min: 5,
  daily_cap: null,
  slot_interval_min: 10,
} as unknown as EventType;

// Monday 2031-03-03 11:40 New York (EST, so 16:40Z), the shape of request 12235b51.
const START = Date.parse("2031-03-03T16:40:00.000Z");
const Z = (hhmm: string) => `2031-03-03T${hhmm}:00.000Z`;

const ADVISORS = ["ends-at-start", "starts-at-end", "eleven-before", "eleven-after"];

const tables = (busy: Row[]) => ({
  availability_schedules: ADVISORS.map((id) => ({
    id: `s-${id}`,
    user_id: id,
    timezone: "America/New_York",
    availability_rules: [{ schedule_id: `s-${id}`, weekday: 1, start_minute: 9 * 60, end_minute: 17 * 60 }],
  })),
  busy_blocks: busy,
  business_hours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    is_open: true,
    start_minute: 6 * 60,
    end_minute: 22 * 60,
  })),
});

const block = (user_id: string, starts_at: string, ends_at: string, id = `${user_id}-${starts_at}`) => ({
  id,
  user_id,
  starts_at,
  ends_at,
  source: "gcal",
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2031-03-01T12:00:00.000Z"));
  dbHolder.db = fakeDb(
    tables([
      // The call is 16:40 to 17:00; its buffered window is 16:30 to 17:10.
      block("ends-at-start", Z("16:20"), Z("16:40")),
      block("starts-at-end", Z("17:00"), Z("17:20")),
      block("eleven-before", Z("16:00"), Z("16:29")),
      block("eleven-after", Z("17:11"), Z("17:30")),
    ]),
  );
});
afterEach(() => vi.useRealTimers());

const candidatesFor = async (advisor: string) =>
  (await roundRobinCandidates(BUCKET, EVENT_TYPE, START, false, advisor)).candidates;

describe("the confirm candidate read judges the buffers it reads (#3273)", () => {
  it("drops an advisor whose meeting ends exactly at the start", async () => {
    expect(await candidatesFor("ends-at-start")).toEqual([]);
  });

  it("drops an advisor whose meeting starts exactly at the end", async () => {
    expect(await candidatesFor("starts-at-end")).toEqual([]);
  });

  it("keeps an advisor whose meeting ends eleven minutes before the start", async () => {
    expect(await candidatesFor("eleven-before")).toEqual(["eleven-before"]);
  });

  it("keeps an advisor whose meeting starts eleven minutes after the end", async () => {
    expect(await candidatesFor("eleven-after")).toEqual(["eleven-after"]);
  });
});

describe("the paged busy read returns every row exactly once (#3273)", () => {
  it("reads 1,500 blocks as 1,500 distinct blocks, whatever order each page arrives in", async () => {
    const base = Date.parse("2031-03-02T00:00:00.000Z");
    const many = Array.from({ length: 1500 }, (_, i) => {
      const s = base + i * 7 * 60_000;
      return block(
        "eleven-before",
        new Date(s).toISOString(),
        new Date(s + 5 * 60_000).toISOString(),
        `id-${String(i).padStart(5, "0")}`,
      );
    });
    dbHolder.db = fakeDb(tables(many));
    const { members } = await loadMembersAvailability(
      BUCKET,
      "2031-03-01T00:00:00.000Z",
      "2031-03-10T00:00:00.000Z",
      async () => ({ ids: ["eleven-before"], fallbackApplied: false }),
    );
    const keys = members[0].busy.map((b) => `${b.start}|${b.end}`);
    expect(keys).toHaveLength(1500);
    expect(new Set(keys).size).toBe(1500);
  });
});
