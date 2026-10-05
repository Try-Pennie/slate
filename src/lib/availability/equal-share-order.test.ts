import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import type { Bucket, EventType } from "@/lib/db/types";
import { log } from "@/lib/log";

// #349: the real assignment path orders a bucket's free advisors by equal share
// (#305), and nothing else. Until #349 it also computed the retired least recently
// booked order on every real assignment and logged the two side by side
// (`routing-shadow`, #321), a comparison nobody was going to act on: equal share is
// live, and the line went to Cloudflare logs, which keep seven days, so the pay
// period it was meant to cover could never be read back. The fairness report (#348)
// is what measures each advisor's share, from the bookings themselves.
//
// This drives `roundRobinCandidates` the way a real book does (not a preview), with
// two advisors free and one of them already booked this pay period, so the order
// is decided by share rather than by a short circuit.

const dbHolder = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof supabaseAdmin> }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => dbHolder.db }));

import { roundRobinCandidates } from "./service";

type Row = Record<string, unknown>;

/** Honours the equality, membership and upper bound filters the reads here use, so
 *  a bookings read scoped to another bucket or advisor really comes back empty. */
function fakeDb(tables: Record<string, Row[]>): ReturnType<typeof supabaseAdmin> {
  const builder = (all: Row[]) => {
    const filters: ((r: Row) => boolean)[] = [];
    let range: [number, number] | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      lt: (c: string, v: string) => (filters.push((r) => Date.parse(String(r[c])) < Date.parse(v)), b),
      gt: (c: string, v: string) => (filters.push((r) => Date.parse(String(r[c])) > Date.parse(v)), b),
      gte: () => b,
      lte: () => b,
      is: () => b,
      limit: () => b,
      order: () => b,
      range: (from: number, to: number) => ((range = [from, to]), b),
      maybeSingle: () => Promise.resolve({ data: all[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
        const rows = all.filter((r) => filters.every((f) => f(r)));
        const data = range ? rows.slice(range[0], range[1] + 1) : rows;
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return b;
  };
  return {
    from: (t: string) => builder(tables[t] ?? []),
    rpc: (name: string) =>
      Promise.resolve({ data: name === "live_reroute_holds" ? [] : {}, error: null }),
  } as unknown as ReturnType<typeof supabaseAdmin>;
}

const BUCKET = {
  id: "b1",
  org_id: "org1",
  code: "111",
  name: "Low",
  criteria: {},
  fallback_user_id: null,
  is_test: false,
} as unknown as Bucket;

const EVENT_TYPE = {
  id: "e1",
  duration_min: 20,
  buffer_before_min: 10,
  buffer_after_min: 10,
  min_notice_min: 5,
  daily_cap: null,
  slot_interval_min: 10,
} as unknown as EventType;

// Monday 2031-03-03 11:40 New York (16:40Z), inside the 2031-02-25 to 03-15 pay period.
const START = Date.parse("2031-03-03T16:40:00.000Z");
const ADVISORS = ["u1", "u2"];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2031-03-01T12:00:00.000Z"));
  dbHolder.db = fakeDb({
    bucket_members: ADVISORS.map((user_id) => ({ bucket_id: "b1", active: true, user_id })),
    users: ADVISORS.map((id) => ({ id, org_id: "org1", bookable: true, attributes: {} })),
    availability_schedules: ADVISORS.map((id) => ({
      id: `s-${id}`,
      user_id: id,
      timezone: "America/New_York",
      availability_rules: [{ schedule_id: `s-${id}`, weekday: 1, start_minute: 9 * 60, end_minute: 17 * 60 }],
    })),
    business_hours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      is_open: true,
      start_minute: 6 * 60,
      end_minute: 22 * 60,
    })),
    busy_blocks: [],
    // u1 already took one routed call in this bucket this pay period; u2 took none.
    bookings: [
      {
        bucket_id: "b1",
        kind: "routed",
        status: "confirmed",
        assigned_user_id: "u1",
        starts_at: "2031-02-27T15:00:00.000Z",
        created_at: "2031-02-26T15:00:00.000Z",
      },
    ],
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the real assignment order (#349)", () => {
  it("offers the advisor with the smaller share first", async () => {
    const { candidates } = await roundRobinCandidates(BUCKET, EVENT_TYPE, START, false);
    expect(candidates).toEqual(["u2", "u1"]);
  });

  it("logs no comparison against the retired least recently booked order", async () => {
    const info = vi.spyOn(log, "info");
    const { candidates } = await roundRobinCandidates(BUCKET, EVENT_TYPE, START, false);
    // Both advisors were ranked, so the line would have been written here if anything still wrote it.
    expect(candidates).toHaveLength(2);
    const tags = info.mock.calls.map(([tag]) => tag);
    expect(tags).not.toContain("routing-shadow");
  });
});
