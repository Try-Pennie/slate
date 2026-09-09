import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { supabaseAdmin } from "@/lib/supabase/admin";

// #1295 gate 1, at the SEAM rather than in the pure core. `scripts/test-business-
// hours-gate.ts` proves the predicate judges the org's window correctly; these prove
// the booker's own read actually consults it. Built is not wired: the gate could be
// perfect and still never run if `getBucketSlots` forgot to load the hours, and no
// pure test could tell.
//
// Two properties, and the second is the one with teeth:
//
//   1. A narrowed org week really does trim the slot list this path returns.
//   2. An UNREADABLE week THROWS out of here rather than answering. The tempting
//      degrade is to serve the agent's own hours unfiltered, which looks like a
//      healthy day and silently re-opens hours an admin narrowed. `recomputeBucket
//      Slots` catches this throw and leaves the previous good row standing, so a
//      failed read shows up as a stale bucket (which alarms) rather than as wrong
//      availability (which does not).

const dbHolder = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof supabaseAdmin> }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => dbHolder.db }));

import { getBucketSlots } from "./service";
import type { Bucket } from "@/lib/db/types";

/** The pool is fixed at one agent, injected, so these tests turn only on the org
 *  hours and never on eligibility resolution (which has its own suite). */
const onlyU1 = () => Promise.resolve({ ids: ["u1"], fallbackApplied: false, legalRelaxed: false });

/** Minimal chainable PostgREST stand-in: enough for the reads this path makes. */
function fakeDb(tables: Record<string, unknown[]>): ReturnType<typeof supabaseAdmin> {
  const builder = (rows: unknown[]) => {
    let range: [number, number] | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      in: () => b,
      lt: () => b,
      gt: () => b,
      lte: () => b,
      gte: () => b,
      is: () => b,
      order: () => b,
      limit: () => b,
      range: (from: number, to: number) => {
        range = [from, to];
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => {
        const data = range ? rows.slice(range[0], range[1] + 1) : rows.slice(0, 1000);
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return b;
  };
  return {
    from: (table: string) => builder(tables[table] ?? []),
    rpc: () => Promise.resolve({ data: {}, error: null }),
  } as unknown as ReturnType<typeof supabaseAdmin>;
}

/** One agent, Monday 09:00-17:00 America/New_York, calendar empty. */
const TABLES = (businessHours: unknown[]) => ({
  buckets: [
    {
      id: "b1",
      org_id: "org1",
      code: "311",
      name: "High",
      criteria: {},
      fallback_user_id: null,
      is_test: false,
      event_type_id: "e1",
      event_types: {
        id: "e1",
        duration_min: 60,
        buffer_before_min: 0,
        buffer_after_min: 0,
        min_notice_min: 0,
        daily_cap: null,
        slot_interval_min: 60,
      },
    },
  ],
  organizations: [{ name: "Org" }],
  bucket_members: [{ bucket_id: "b1", user_id: "u1", active: true }],
  users: [{ id: "u1", attributes: {}, bookable: true, deactivated_at: null }],
  availability_schedules: [
    {
      id: "s1",
      user_id: "u1",
      timezone: "America/New_York",
      availability_rules: [
        { schedule_id: "s1", weekday: 1, start_minute: 9 * 60, end_minute: 17 * 60 },
      ],
    },
  ],
  business_hours: businessHours,
});

const openDay = (weekday: number, start: number, end: number) => ({
  weekday,
  is_open: true,
  start_minute: start,
  end_minute: end,
});
const closedDay = (weekday: number) => ({
  weekday,
  is_open: false,
  start_minute: 0,
  end_minute: 0,
});

// Monday 2026-07-13 through Tuesday, so exactly one working day is in range.
const FROM = "2026-07-13T04:00:00.000Z"; // 00:00 Monday, New York
const TO = "2026-07-14T04:00:00.000Z";

// `getBucketSlots` reads the host clock for the minimum-notice check, so the clock is
// pinned rather than the window dated into the future: a future-dated fixture quietly
// becomes a past-dated one and every slot starts failing min_notice instead of the
// rule under test.
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-07-10T12:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("the booker's slot read runs gate 1 (#1295)", () => {
  it("a wide org week leaves the agent's own day untouched", async () => {
    // Open 08:00-20:00 every day: a strict superset of the agent's 09:00-17:00, which
    // is the shape production is in today. Eight one-hour slots, 09:00 to 16:00.
    dbHolder.db = fakeDb(
      TABLES([1, 2, 3, 4, 5, 6, 7].map((d) => openDay(d, 8 * 60, 20 * 60))),
    );

    const result = await getBucketSlots("311", FROM, TO, onlyU1 as (b: Bucket) => ReturnType<typeof onlyU1>);

    expect(result?.slots).toHaveLength(8);
    expect(result?.slots[0]).toBe("2026-07-13T13:00:00.000Z"); // 09:00 EDT
  });

  it("a narrowed org week trims the day, proving the hours are actually consulted", async () => {
    // Same agent, org open only 10:00-15:00 Monday: 10:00, 11:00, 12:00, 13:00, 14:00.
    dbHolder.db = fakeDb(
      TABLES([
        openDay(1, 10 * 60, 15 * 60),
        ...[2, 3, 4, 5, 6, 7].map((d) => closedDay(d)),
      ]),
    );

    const result = await getBucketSlots("311", FROM, TO, onlyU1 as (b: Bucket) => ReturnType<typeof onlyU1>);

    expect(result?.slots).toHaveLength(5);
    expect(result?.slots[0]).toBe("2026-07-13T14:00:00.000Z"); // 10:00 EDT
  });

  it("a day the org is closed offers nothing, however wide the agent's hours", async () => {
    dbHolder.db = fakeDb(TABLES([1, 2, 3, 4, 5, 6, 7].map((d) => closedDay(d))));

    const result = await getBucketSlots("311", FROM, TO, onlyU1 as (b: Bucket) => ReturnType<typeof onlyU1>);

    expect(result?.slots).toEqual([]);
  });

  it("an UNREADABLE stored week throws rather than serving the agent's hours unfiltered", async () => {
    // Six of seven weekdays stored: the resolver refuses a partial week rather than
    // guessing at the missing one. Serving 8 slots here would be the silent failure:
    // it is indistinguishable from a healthy day, so nobody would ever look.
    dbHolder.db = fakeDb(TABLES([1, 2, 3, 4, 5, 6].map((d) => openDay(d, 8 * 60, 20 * 60))));

    // The pool is healthy here, so the throw is the ONLY thing standing between the
    // caller and eight cheerfully wrong slots.
    await expect(
      getBucketSlots("311", FROM, TO, onlyU1 as (b: Bucket) => ReturnType<typeof onlyU1>),
    ).rejects.toThrow(/unusable|incomplete/i);
  });
});
