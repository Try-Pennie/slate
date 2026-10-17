import { describe, it, expect, vi, beforeEach } from "vitest";

// The live reads behind the lost race judgement (#3797). What matters is the failure
// direction: a read that fails must THROW (the caller records `unknown`), never come
// back short, because "nothing written since the list" is the answer that would turn a
// stale offer into a race.

type Result = { data: unknown; error: { message: string } | null };
const answers = vi.hoisted(() => ({
  slots: { data: [], error: null } as Result,
  blocks: { data: [], error: null } as Result,
  proofs: { data: [], error: null } as Result,
  calls: [] as unknown[][],
}));

vi.mock("@/lib/supabase/admin", () => {
  const chain = (table: string) => {
    const b: Record<string, unknown> = {};
    const result = (): Result =>
      table === "bucket_slots" ? answers.slots : table === "busy_blocks" ? answers.blocks : answers.proofs;
    for (const m of ["select", "in", "lt", "gt", "overlaps", "order", "not", "eq"]) {
      b[m] = (...args: unknown[]) => {
        answers.calls.push([table, m, ...args]);
        // `in` closes the bucket_slots read; `limit` closes the proof read.
        if (table === "bucket_slots" && m === "in") return Promise.resolve(result());
        return b;
      };
    }
    b.limit = async (...args: unknown[]) => {
      answers.calls.push([table, "limit", ...args]);
      return result();
    };
    b.range = async (...args: unknown[]) => {
      answers.calls.push([table, "range", ...args]);
      return result();
    };
    return b;
  };
  return { supabaseAdmin: () => ({ from: chain }) };
});

import { judgeRefusedOfferLive } from "./offer-race-live";
import type { RefusalTrace } from "./refusal-trace";

const START = "2026-10-17T21:10:00.000Z";
const SERVED = "2026-10-16T02:00:07.526Z";
const EVENT = { duration_min: 30, buffer_before_min: 10, buffer_after_min: 10 };
const trace = (over: Partial<RefusalTrace> = {}): RefusalTrace => ({
  requestedStart: START,
  bucketCode: "112",
  stage: "candidate_read_empty",
  rungs: [{ code: "112", members: 2, read: 0, claimed: 0, checked: 0, stage: "candidate_read_empty", memberIds: ["a", "b"] }],
  ...over,
});

beforeEach(() => {
  answers.calls.length = 0;
  answers.slots = { data: [], error: null };
  answers.blocks = { data: [], error: null };
  answers.proofs = { data: [], error: null };
});

describe("judgeRefusedOfferLive", () => {
  it("judges nothing for a refusal that is not a cached free check one", async () => {
    const out = await judgeRefusedOfferLive({ trace: trace({ stage: "verify_busy" }), servedComputedAt: SERVED, eventType: EVENT });
    expect(out).toEqual({ verdict: null, staleRowCodes: [], storedRows: [] });
    expect(answers.calls).toEqual([]);
  });

  it("with no computed_at, leaves its row proof and judges no race", async () => {
    answers.slots = { data: [], error: null };
    const out = await judgeRefusedOfferLive({ trace: trace(), servedComputedAt: null, eventType: EVENT });
    expect(out.verdict).toBeNull();
    expect(answers.calls.some((c) => c[0] === "busy_blocks")).toBe(false);
  });

  it("calls a race when an advisor's only block over the window was written after the list", async () => {
    answers.blocks = {
      data: [
        { id: "1", user_id: "a", created_at: "2026-10-15T20:00:00Z", source: "gcal" },
        { id: "2", user_id: "b", created_at: "2026-10-16T02:02:31.982Z", source: "gcal" },
      ],
      error: null,
    };
    const out = await judgeRefusedOfferLive({ trace: trace(), servedComputedAt: SERVED, eventType: EVENT });
    expect(out.verdict).toBe("race");
    // The buffered window: ten minutes either side of the thirty minute call.
    expect(answers.calls).toContainEqual(["busy_blocks", "lt", "starts_at", "2026-10-17T21:50:00.000Z"]);
    expect(answers.calls).toContainEqual(["busy_blocks", "gt", "ends_at", "2026-10-17T21:00:00.000Z"]);
    // The proof read asks for refusals on these codes since the list was computed.
    expect(answers.calls).toContainEqual(["routing_decisions", "overlaps", "stale_row_codes", ["112"]]);
    expect(answers.calls).toContainEqual(["routing_decisions", "gt", "created_at", SERVED]);
  });

  it("calls a stale offer when a refusal proved the row stale after the list", async () => {
    answers.blocks = { data: [{ id: "2", user_id: "b", created_at: "2026-10-16T02:02:31.982Z", source: "gcal" }], error: null };
    answers.proofs = { data: [{ created_at: "2026-10-16T02:02:32.422Z" }], error: null };
    const out = await judgeRefusedOfferLive({ trace: trace(), servedComputedAt: SERVED, eventType: EVENT });
    expect(out.verdict).toBe("stale_offer");
  });

  it("is unknown when a rung did not say who was in it, never a race", async () => {
    const t = trace({ rungs: [{ code: "112", members: 2, read: 0, claimed: 0, checked: 0, stage: "candidate_read_empty" }] });
    const out = await judgeRefusedOfferLive({ trace: t, servedComputedAt: SERVED, eventType: EVENT });
    expect(out.verdict).toBe("unknown");
  });

  it("THROWS when the busy blocks cannot be read, rather than finding nothing written", async () => {
    answers.blocks = { data: null, error: { message: "statement timeout" } };
    await expect(judgeRefusedOfferLive({ trace: trace(), servedComputedAt: SERVED, eventType: EVENT })).rejects.toThrow(/statement timeout/);
  });

  it("THROWS when the row proofs cannot be read", async () => {
    answers.proofs = { data: null, error: { message: "permission denied" } };
    await expect(judgeRefusedOfferLive({ trace: trace(), servedComputedAt: SERVED, eventType: EVENT })).rejects.toThrow(/permission denied/);
  });

  it("THROWS when the stored rows cannot be read", async () => {
    answers.slots = { data: null, error: { message: "connection reset" } };
    await expect(judgeRefusedOfferLive({ trace: trace(), servedComputedAt: SERVED, eventType: EVENT })).rejects.toThrow(/connection reset/);
  });
});
