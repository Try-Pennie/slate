import { describe, it, expect, vi, beforeEach } from "vitest";

// #762: the agent -> buckets lookup used to cost 3 queries PER AGENT, and one of
// the three (fetch the whole org's buckets) returned identical rows every time.
// Three copies of the same serial loop ran it: both self-heal reconcile sweeps and
// the Google sync lane, all on the shared every-minute invocation. Batching makes
// the query count constant in the number of agents.

const state = vi.hoisted(() => ({
  users: [] as Record<string, unknown>[],
  buckets: [] as Record<string, unknown>[],
  members: [] as Record<string, unknown>[],
  slotRows: [] as Record<string, unknown>[],
  queries: [] as string[],
  failTable: null as string | null,
}));

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  b.select = () => {
    state.queries.push(table);
    return b;
  };
  b.eq = self;
  b.in = self;
  b.maybeSingle = () => Promise.resolve(result(table));
  b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(result(table)).then(onF, onR);
  return b;
}

function result(table: string) {
  if (state.failTable === table) return { data: null, error: { message: "db exploded" } };
  if (table === "users") return { data: state.users, error: null };
  if (table === "buckets") return { data: state.buckets, error: null };
  if (table === "bucket_members") return { data: state.members, error: null };
  // Null when empty so readBucketSlotsRow's maybeSingle still sees a clean miss.
  if (table === "bucket_slots") {
    return { data: state.slotRows.length ? state.slotRows : null, error: null };
  }
  return { data: null, error: null };
}

const from = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import {
  bucketsForAgent,
  bucketsForAgents,
  listPoolBuckets,
  listKnownBucketSlotRows,
  readBucketSlotsRow,
  touchedBucketCodes,
} from "./precompute";

const ORG = "org1";

beforeEach(() => {
  vi.clearAllMocks();
  state.queries = [];
  state.failTable = null;
  state.users = [];
  state.slotRows = [];
  state.buckets = [
    // Matched by attribute criteria.
    { id: "b-debt", code: "411", criteria: { team: "debt" }, fallback_user_id: null, org_id: ORG },
    // Matched only by manual membership.
    { id: "b-manual", code: "412", criteria: {}, fallback_user_id: null, org_id: ORG },
    // Matched only by being the fallback agent.
    { id: "b-fb", code: "413", criteria: { team: "nobody" }, fallback_user_id: "u3", org_id: ORG },
  ];
  state.members = [];
  from.mockImplementation((table: string) => makeBuilder(table));
});

describe("bucketsForAgents", () => {
  it("costs a constant 3 queries regardless of how many agents (not 3 per agent)", async () => {
    state.users = Array.from({ length: 60 }, (_, i) => ({
      id: `u${i}`,
      org_id: ORG,
      attributes: { team: "debt" },
    }));

    const byAgent = await bucketsForAgents(state.users.map((u) => u.id as string));

    expect(byAgent.size).toBe(60);
    // The whole point of #762: 3 reads for 60 agents, where the old loop did 180.
    expect(state.queries).toEqual(["users", "buckets", "bucket_members"]);
  });

  it("resolves each agent's own buckets: criteria, manual membership, and fallback", async () => {
    state.users = [
      { id: "u1", org_id: ORG, attributes: { team: "debt" } }, // criteria match
      { id: "u2", org_id: ORG, attributes: { team: "other" } }, // manual member only
      { id: "u3", org_id: ORG, attributes: { team: "other" } }, // fallback only
    ];
    state.members = [{ bucket_id: "b-manual", user_id: "u2" }];

    const byAgent = await bucketsForAgents(["u1", "u2", "u3"]);

    expect(byAgent.get("u1")).toEqual(["411"]);
    expect(byAgent.get("u2")).toEqual(["412"]);
    expect(byAgent.get("u3")).toEqual(["413"]);
  });

  it("does not leak one agent's manual membership to another agent", async () => {
    state.users = [
      { id: "u1", org_id: ORG, attributes: {} },
      { id: "u2", org_id: ORG, attributes: {} },
    ];
    // Only u2 is a member. Batching loads all members at once, so a naive
    // implementation could hand u1 the same bucket.
    state.members = [{ bucket_id: "b-manual", user_id: "u2" }];

    const byAgent = await bucketsForAgents(["u1", "u2"]);

    expect(byAgent.get("u1")).toEqual([]);
    expect(byAgent.get("u2")).toEqual(["412"]);
  });

  it("issues no query at all for an empty agent list", async () => {
    const byAgent = await bucketsForAgents([]);

    expect(byAgent.size).toBe(0);
    expect(state.queries).toEqual([]);
  });

  it("fails loud on a query error rather than reporting zero buckets (#313)", async () => {
    state.users = [{ id: "u1", org_id: ORG, attributes: { team: "debt" } }];
    state.failTable = "buckets";

    await expect(bucketsForAgents(["u1"])).rejects.toThrow();
  });
});

describe("bucketsForAgent", () => {
  it("still answers for a single agent (one implementation, not two)", async () => {
    state.users = [{ id: "u1", org_id: ORG, attributes: { team: "debt" } }];

    expect(await bucketsForAgent("u1")).toEqual(["411"]);
  });

  it("returns nothing for an unknown agent", async () => {
    state.users = [];

    expect(await bucketsForAgent("ghost")).toEqual([]);
  });
});

describe("touchedBucketCodes", () => {
  it("dedupes across agents and caps the result", async () => {
    state.users = [
      { id: "u1", org_id: ORG, attributes: { team: "debt" } },
      { id: "u2", org_id: ORG, attributes: { team: "debt" } }, // same bucket as u1
    ];

    expect(await touchedBucketCodes(["u1", "u2"], 25, "reconcile")).toEqual(["411"]);
    // The cap is what bounds the downstream recompute fan-out.
    expect(await touchedBucketCodes(["u1", "u2"], 0, "reconcile")).toEqual([]);
  });

  it("swallows a lookup failure into an empty set so one bad read cannot kill the tick", async () => {
    state.users = [{ id: "u1", org_id: ORG, attributes: { team: "debt" } }];
    state.failTable = "buckets";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const codes = await touchedBucketCodes(["u1"], 25, "reconcile");

    // No throw: the caller is a best-effort refresh and the recompute lane's
    // freshness sweep is the backstop. But it must not fail SILENTLY.
    expect(codes).toEqual([]);
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
  });
});

// #315: the precompute reads used to swallow the query error
// (`const { data } = await ...`), so a failed read looked like an empty cache /
// missing bucket instead of a broken deploy. They now route through unwrap and
// must THROW on a real error rather than degrade to null/empty.
describe("precompute reads fail loud on a query error (#315)", () => {
  it("readBucketSlotsRow throws on a query error, returns null on a clean miss", async () => {
    state.failTable = "bucket_slots";
    await expect(readBucketSlotsRow("411")).rejects.toThrow();

    state.failTable = null; // clean miss: data null, error null
    expect(await readBucketSlotsRow("411")).toBeNull();
  });

  // #2245: this replaced a plain `select("code")`, because the lane groups by
  // pool before it dispatches. An empty bucket list would leave the lane with
  // nothing due and every row aging quietly past the freshness window, so BOTH
  // reads have to throw rather than degrade.
  it("listPoolBuckets throws when the bucket read fails", async () => {
    state.failTable = "buckets";
    await expect(listPoolBuckets()).rejects.toThrow();
  });

  it("listPoolBuckets throws when the MEMBERSHIP read fails", async () => {
    // Membership is a pool input, so a silently empty member list would merge
    // two buckets that route to different people.
    state.failTable = "bucket_members";
    await expect(listPoolBuckets()).rejects.toThrow();
  });

  it("listPoolBuckets carries each bucket's pool inputs and its own row", async () => {
    state.members = [
      { bucket_id: "b-manual", user_id: "u1" },
      { bucket_id: "b-manual", user_id: "u2" },
    ];
    const pooled = await listPoolBuckets();
    expect(pooled.map((p) => p.code)).toEqual(["411", "412", "413"]);

    const manual = pooled.find((p) => p.code === "412")!;
    expect(manual.memberIds.sort()).toEqual(["u1", "u2"]);
    expect(manual.orgId).toBe(ORG);
    // The row itself rides along: it is what each pooled write stamps as the
    // code's own identity, so a shared answer never carries a sibling's bucket.
    expect(manual.bucket.id).toBe("b-manual");

    const fallback = pooled.find((p) => p.code === "413")!;
    expect(fallback.fallbackUserId).toBe("u3");
    expect(fallback.memberIds).toEqual([]);
  });

  it("listKnownBucketSlotRows throws on a query error", async () => {
    state.failTable = "bucket_slots";
    await expect(listKnownBucketSlotRows()).rejects.toThrow();
  });
});

// #1169: a bucket_slots row whose computed_at cannot be parsed must read as
// computed at epoch 0 (infinitely old), never NaN. A NaN age compared false
// against the freshness window, so the bucket was never recomputed (the booker
// kept serving a frozen slot cache) and staleBuckets never flagged it: broken
// and invisible at once. Epoch 0 puts it first in line to recompute and flags
// it stale immediately.
describe("listKnownBucketSlotRows on a corrupt computed_at (#1169)", () => {
  it("maps an unparseable computed_at to 0, and a healthy one to its epoch ms", async () => {
    const iso = "2026-07-29T12:00:00.000Z";
    state.slotRows = [
      { bucket_code: "411", computed_at: "not-a-timestamp" },
      { bucket_code: "412", computed_at: iso },
    ];
    // #3388: each row also carries its compute's start, null where it has none.
    expect(await listKnownBucketSlotRows()).toEqual([
      { code: "411", computedAtMs: 0, startedAtMs: null },
      { code: "412", computedAtMs: Date.parse(iso), startedAtMs: null },
    ]);
  });
});
