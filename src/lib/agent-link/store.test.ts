import { describe, it, expect, vi, beforeEach } from "vitest";

// #2831: the pool a refused advisor link offers instead. Only a token still naming
// somebody who has left or is not bookable is read at all; every other refusal
// answers the catch all with no read, and a failed read throws rather than
// quietly offering the catch all to a lead whose pool is known.

type Result = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({
  results: {} as Record<string, Result>,
  reads: [] as string[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      db.reads.push(table);
      const res = db.results[table] ?? { data: null, error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => Promise.resolve(res),
        maybeSingle: () => Promise.resolve(res),
      };
      return chain;
    },
  }),
}));
const precompute = vi.hoisted(() => ({ bucketsForAgent: vi.fn(async () => ["511", "411", "SMOKE"]) }));
vi.mock("@/lib/availability/precompute", () => precompute);

import { agentLinkPoolCode } from "./store";

const TOKEN = "ab".repeat(32);

beforeEach(() => {
  db.reads = [];
  db.results = {
    agent_links: { data: { user_id: "u1" }, error: null },
    buckets: {
      data: [
        { code: "511", is_test: false },
        { code: "411", is_test: false },
        { code: "SMOKE", is_test: true },
      ],
      error: null,
    },
  };
  precompute.bucketsForAgent.mockClear();
});

describe("agentLinkPoolCode (#2831)", () => {
  it.each(["departed", "not_bookable"] as const)("offers a %s advisor's lowest real bucket", async (why) => {
    expect(await agentLinkPoolCode(TOKEN, why)).toBe("411");
    expect(precompute.bucketsForAgent).toHaveBeenCalledWith("u1");
  });

  it.each(["unknown", "no_bucket"] as const)("answers the catch all for %s without reading anything", async (why) => {
    expect(await agentLinkPoolCode(TOKEN, why)).toBeNull();
    expect(db.reads).toEqual([]);
  });

  it("answers the catch all for a token that no longer names anybody", async () => {
    db.results.agent_links = { data: null, error: null };
    expect(await agentLinkPoolCode(TOKEN, "departed")).toBeNull();
    expect(precompute.bucketsForAgent).not.toHaveBeenCalled();
  });

  it("answers the catch all for an advisor in only a test bucket", async () => {
    db.results.buckets = { data: [{ code: "SMOKE", is_test: true }], error: null };
    expect(await agentLinkPoolCode(TOKEN, "not_bookable")).toBeNull();
  });

  it("throws on a failed link read rather than offering the catch all", async () => {
    db.results.agent_links = { data: null, error: { message: "boom" } };
    await expect(agentLinkPoolCode(TOKEN, "departed")).rejects.toThrow("boom");
  });

  it("throws on a failed bucket read rather than offering the catch all", async () => {
    db.results.buckets = { data: null, error: { message: "buckets down" } };
    await expect(agentLinkPoolCode(TOKEN, "departed")).rejects.toThrow("buckets down");
  });
});
