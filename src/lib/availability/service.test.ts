import { describe, it, expect, vi, beforeEach } from "vitest";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import type { Bucket } from "@/lib/db/types";

// #828 (C1): loadMembersAvailability reads busy_blocks for a whole tier pool over a
// multi-day window; with no pagination that read stops at PostgREST's 1,000-row cap
// and drops busy blocks (an agent looks free and gets overbooked, the #35/#166
// class). This still pages.
//
// #832 (C2): the per-agent daily-cap COUNT moved off the row read onto a server-side
// RPC that returns a single jsonb map (cap-proof, no 1,000-row SETOF ceiling). The
// APP resolves each agent's timezone and passes it to the RPC (p_tz_by_user), so the
// count's local-day bucketing uses the SAME tz the app uses for the slot-day and
// working-hours checks; a divergent tz would miscount the cap and overbook. These
// tests pin the busy paging, the RPC wiring + tz source-of-truth, and fail-loud on
// an RPC error.

const dbHolder = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof supabaseAdmin> }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => dbHolder.db }));

import { loadMembersAvailability, getBucketSlots, loadBucketSlotInputs } from "./service";

type Rows = Record<string, unknown[]>;
interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}
interface RpcCall {
  name: string;
  params: Record<string, unknown>;
}

/** Chainable supabase stand-in emulating PostgREST's paging contract (a read without
 *  `.range()` caps at the first 1,000 rows; with `.range(from,to)` returns exactly
 *  that window) plus an `.rpc()` that records its calls and returns a canned result. */
function fakeDb(
  tables: Rows,
  rpc: { result?: RpcResult; calls?: RpcCall[] } = {},
): ReturnType<typeof supabaseAdmin> {
  const builder = (table: string, tableRows: unknown[]) => {
    // A fixture row naming no primary key is given one by its position, in key order,
    // since a paged read cuts each later page on it (keyset paging, 2026-10-25).
    let rows = tableRows.map((r, i) => ({ id: `${table}-${String(i).padStart(6, "0")}`, ...(r as Record<string, unknown>) }));
    let range: [number, number] | null = null;
    // A range filter is honoured on a row carrying that column, as PostgREST would, so
    // a read window that stops short leaves the row out here too. A row without the
    // column is kept, so tables no filter is aimed at pass through unchanged.
    const keep = (col: string, ok: (v: string) => boolean) => {
      rows = rows.filter((r) => {
        const v = (r as Record<string, unknown>)[col];
        return typeof v !== "string" || ok(v);
      });
      return b;
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      in: () => b,
      lt: (col: string, v: string) => keep(col, (x) => Date.parse(x) < Date.parse(v)),
      gt: (col: string, v: string) => keep(col, (x) => (col === "id" ? x > v : Date.parse(x) > Date.parse(v))),
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
    from: (table: string) => builder(table, tables[table] ?? []),
    rpc: (name: string, params: Record<string, unknown>) => {
      rpc.calls?.push({ name, params });
      return Promise.resolve(rpc.result ?? { data: {}, error: null });
    },
  } as unknown as ReturnType<typeof supabaseAdmin>;
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

describe("loadMembersAvailability", () => {
  it("C1: keeps busy blocks past the 1,000-row cap so a busy agent is not shown free", async () => {
    // 1,001 busy blocks for u1. Truncation at 1,000 would drop the last one.
    const busy = Array.from({ length: 1001 }, (_, i) => ({
      user_id: "u1",
      starts_at: `2026-07-13T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      ends_at: `2026-07-13T${String(i % 24).padStart(2, "0")}:30:00.000Z`,
    }));
    dbHolder.db = fakeDb({ ...POOL_TABLES(), busy_blocks: busy });

    const [member] = (await loadMembersAvailability(BUCKET, FROM, TO)).members;

    expect(member.userId).toBe("u1");
    expect(member.busy).toHaveLength(1001);
  });

  it("C2: counts bookings via the server-side RPC (cap-proof), passing the app-resolved tz", async () => {
    const calls: RpcCall[] = [];
    // A count above 1,000 proves cap-proofing: a single jsonb scalar never truncates.
    dbHolder.db = fakeDb(POOL_TABLES(), {
      result: { data: { "u1|2026-07-13": 1500 }, error: null },
      calls,
    });

    const [member] = (await loadMembersAvailability(BUCKET, FROM, TO)).members;

    expect(member.dayCounts?.get("2026-07-13")).toBe(1500);
    // The RPC was handed the app-resolved tz so its local-day bucketing can't diverge
    // from the app's per-agent tz (the #832 overbooking fix).
    const call = calls.find((c) => c.name === "count_bookings_per_local_day");
    expect(call?.params.p_tz_by_user).toEqual({ u1: "America/New_York" });
    expect(call?.params.p_user_ids).toContain("u1");
  });

  it("C2 fail-loud: throws when the daily-cap RPC errors (never silently under-counts)", async () => {
    dbHolder.db = fakeDb(POOL_TABLES(), {
      result: { data: null, error: { message: "boom" } },
    });

    await expect(loadMembersAvailability(BUCKET, FROM, TO)).rejects.toThrow(/boom|daily-cap/i);
  });
});

// #508: the recompute lane threads a cached eligibility resolver down the shared
// getBucketSlots -> loadMembersAvailability path, while the booker read + booking
// verify keep the live default. The seam is one injectable resolver param whose
// ids are what actually drive the pool (proving the resolver, not the live DB
// read, decides eligibility on the recompute path).
describe("eligible-resolver threading (#508)", () => {
  it("loadMembersAvailability uses the INJECTED resolver's ids, not the live DB pool", async () => {
    // The DB pool has a live agent (u1), but the injected resolver returns NONE,
    // so an empty result proves the injected resolver decided eligibility.
    dbHolder.db = fakeDb(POOL_TABLES());
    const resolver = vi.fn((_b: Bucket) =>
      Promise.resolve({ ids: [] as string[], fallbackApplied: false }),
    );

    const { members } = await loadMembersAvailability(BUCKET, FROM, TO, resolver);

    expect(members).toHaveLength(0);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][0]).toBe(BUCKET);
  });

  it("getBucketSlots forwards the resolver down to loadMembersAvailability", async () => {
    dbHolder.db = fakeDb({
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
            duration_min: 30,
            buffer_before_min: 0,
            buffer_after_min: 0,
            min_notice_min: 0,
            daily_cap: null,
            slot_interval_min: 15,
          },
        },
      ],
      organizations: [{ name: "Org" }],
      ...POOL_TABLES(),
    });
    const resolver = vi.fn((_b: Bucket) =>
      Promise.resolve({ ids: [] as string[], fallbackApplied: false }),
    );

    const result = await getBucketSlots("311", FROM, TO, resolver);

    expect(resolver).toHaveBeenCalledTimes(1);
    // The resolver is handed the resolved bucket (by code), proving getBucketSlots
    // threaded it into loadMembersAvailability rather than calling the live default.
    expect(resolver.mock.calls[0][0].code).toBe("311");
    // Empty pool -> no members -> no slots (the resolver's [] drove it).
    expect(result?.slots).toEqual([]);
  });
});

// #3258: the load run's reads-only arm reaches the recompute's reads through
// loadBucketSlotInputs, the function getBucketSlots itself reads through, so the two
// can never make different reads.
describe("loadBucketSlotInputs (#3258)", () => {
  const BUCKET_ROW = {
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
      duration_min: 30,
      buffer_before_min: 0,
      buffer_after_min: 0,
      min_notice_min: 0,
      daily_cap: null,
      slot_interval_min: 15,
    },
  };

  it("makes the reads a compute needs, with the resolver threaded, and computes nothing", async () => {
    dbHolder.db = fakeDb({ buckets: [BUCKET_ROW], organizations: [{ name: "Org" }], ...POOL_TABLES() });
    const resolver = vi.fn((_b: Bucket) => Promise.resolve({ ids: [] as string[], fallbackApplied: false }));
    const inputs = await loadBucketSlotInputs("311", FROM, TO, resolver);
    expect(inputs?.resolved.bucket.code).toBe("311");
    expect(inputs?.membersResult.members).toEqual([]);
    expect(inputs).not.toHaveProperty("slots");
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  // The recompute's window ends at a UTC midnight, so its last slot can end exactly
  // there, with the gap after the call reaching past it. On 2026-10-15 a Phoenix
  // advisor's block starting at that midnight was never read, so bucket 320 offered
  // 7:40pm ET on Tuesday 20 October for a day while the confirm, which reads busy time
  // over the buffered window (#3273), refused every lead who chose it.
  it("reads busy time past the window's end by the gap after a call, so the last slot sees a block in it", async () => {
    // Friday 16 July 2027, an advisor on shift until 20:00 New York, which is 00:00 UTC:
    // the end of this search window. The 19:30 call ends there, and its 10 minute gap
    // after runs into a block starting at exactly that instant.
    const from = "2027-07-13T00:00:00.000Z";
    const to = "2027-07-17T00:00:00.000Z";
    const allWeek = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, is_open: true, start_minute: 0, end_minute: 1440 }));
    dbHolder.db = fakeDb({
      buckets: [{ ...BUCKET_ROW, event_types: { ...BUCKET_ROW.event_types, buffer_before_min: 10, buffer_after_min: 10 } }],
      organizations: [{ name: "Org" }],
      business_hours: allWeek,
      ...POOL_TABLES(),
      availability_schedules: [
        {
          id: "s1",
          user_id: "u1",
          timezone: "America/New_York",
          availability_rules: [{ schedule_id: "s1", weekday: 5, start_minute: 18 * 60, end_minute: 20 * 60 }],
        },
      ],
      busy_blocks: [{ user_id: "u1", starts_at: to, ends_at: "2027-07-17T01:00:00.000Z", source: "google" }],
    });
    const result = await getBucketSlots("311", from, to, () => Promise.resolve({ ids: ["u1"], fallbackApplied: false }));
    // The 19:00 call's gap ends at 19:40, clear of the block; the 19:30 call's does not.
    expect(result?.slots).toContain("2027-07-16T23:00:00.000Z");
    expect(result?.slots).not.toContain("2027-07-16T23:30:00.000Z");
  });

  it("answers null for a code that names no bucket, exactly as getBucketSlots does", async () => {
    dbHolder.db = fakeDb({ buckets: [], organizations: [], ...POOL_TABLES() });
    expect(await loadBucketSlotInputs("999", FROM, TO)).toBeNull();
    expect(await getBucketSlots("999", FROM, TO)).toBeNull();
  });
});
