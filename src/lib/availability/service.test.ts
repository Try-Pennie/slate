import { describe, it, expect, vi, beforeEach } from "vitest";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import type { Bucket } from "@/lib/db/types";

// #828 (C1/C2): loadMembersAvailability reads busy_blocks and bookings for a
// whole tier pool over a multi-day window and consumes them as aggregates (busy
// intervals + the per-agent daily-cap count). With no pagination those reads
// stop at PostgREST's 1,000-row cap, dropping busy blocks (an agent looks free
// and gets overbooked) and bookings (the cap under-counts, so Slate over-offers
// slots): the #35 / #166 failure class. These tests pin that the reads page.

const dbHolder = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof supabaseAdmin> }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => dbHolder.db }));

import { loadMembersAvailability } from "./service";

type Rows = Record<string, unknown[]>;

/** Chainable supabase stand-in that emulates PostgREST's paging contract: a read
 *  WITHOUT `.range()` returns at most the first 1,000 rows (the silent cap this
 *  bug is about); a read WITH `.range(from,to)` returns exactly that window, so a
 *  paginating caller can walk past 1,000. Filters are ignored (fixtures are
 *  pre-scoped to the one agent under test). */
function fakeDb(tables: Rows): ReturnType<typeof supabaseAdmin> {
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
  return { from: (table: string) => builder(tables[table] ?? []) } as unknown as ReturnType<
    typeof supabaseAdmin
  >;
}

const BUCKET = {
  id: "b1",
  org_id: "org1",
  code: "311",
  name: "High",
  criteria: {},
  fallback_user_id: null,
  is_test: false,
} as unknown as Bucket;

// A one-agent pool: u1 is an active manual member AND a bookable org agent.
const POOL_TABLES = () => ({
  bucket_members: [{ bucket_id: "b1", user_id: "u1", active: true }],
  users: [{ id: "u1", attributes: {}, bookable: true, deactivated_at: null }],
  availability_schedules: [
    { id: "s1", user_id: "u1", timezone: "America/New_York", availability_rules: [] },
  ],
});

const FROM = "2026-07-13T00:00:00.000Z";
const TO = "2026-07-17T00:00:00.000Z";

beforeEach(() => vi.clearAllMocks());

describe("loadMembersAvailability pagination (#828)", () => {
  it("C1: keeps busy blocks past the 1,000-row cap so a busy agent is not shown free", async () => {
    // 1,001 busy blocks for u1. Truncation at 1,000 would drop the last one.
    const busy = Array.from({ length: 1001 }, (_, i) => ({
      user_id: "u1",
      starts_at: `2026-07-13T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      ends_at: `2026-07-13T${String(i % 24).padStart(2, "0")}:30:00.000Z`,
    }));
    dbHolder.db = fakeDb({ ...POOL_TABLES(), busy_blocks: busy });

    const [member] = await loadMembersAvailability(BUCKET, FROM, TO);

    expect(member.userId).toBe("u1");
    expect(member.busy).toHaveLength(1001);
  });

  it("C2: counts bookings past the 1,000-row cap so the daily cap is not under-counted", async () => {
    const bookings = Array.from({ length: 1001 }, (_, i) => ({
      assigned_user_id: "u1",
      starts_at: `2026-07-13T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
    }));
    dbHolder.db = fakeDb({ ...POOL_TABLES(), bookings });

    const [member] = await loadMembersAvailability(BUCKET, FROM, TO);

    expect(member.bookingStartsMs).toHaveLength(1001);
  });
});
