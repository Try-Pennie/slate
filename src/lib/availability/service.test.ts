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

import { loadMembersAvailability, getBucketSlots } from "./service";

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
      Promise.resolve({ ids: [] as string[], fallbackApplied: false, legalRelaxed: false }),
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
      Promise.resolve({ ids: [] as string[], fallbackApplied: false, legalRelaxed: false }),
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
