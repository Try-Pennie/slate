import { describe, it, expect, vi, beforeEach } from "vitest";

// recordRoutingDecision persists a routing decision row and fires a misroute
// Slack alert only when the chosen agent fails the bucket criteria AND no
// intentional fallback (empty-pool or tier-drop) explains it. It is always
// best-effort: a DB insert rejection must never propagate to the caller.
const insert = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const from = vi.hoisted(() => vi.fn(() => ({ insert })));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ from }),
}));
vi.mock("@/lib/notify/dispatch", () => dispatch);

import { recordRoutingDecision } from "./record";
import type { Attributes, Criteria, RoutingExclusion } from "@/lib/db/types";

const baseInput = {
  orgId: "org-1",
  bookingId: "bk-1",
  bucketCode: "XBC",
  bucketId: "bucket-1",
  criteria: { debt_team: "ultra_high" } satisfies Criteria,
  considered: ["u1", "u2"],
  excluded: [{ user_id: "u3", reason: "criteria_miss" }] satisfies RoutingExclusion[],
  chosenUserId: "u1",
  chosenAttributes: { debt_team: "ultra_high" } satisfies Attributes,
  emptyPoolFallback: false,
  tierFallback: false,
  rungsDropped: 0,
  requestedTier: "standard",
  bookedTier: "standard",
  outcome: "booked" as const,
};

beforeEach(() => vi.clearAllMocks());

describe("recordRoutingDecision", () => {
  it("inserts a routing_decisions row with the expected fields for a normal booked decision", async () => {
    await recordRoutingDecision(baseInput);

    expect(from).toHaveBeenCalledWith("routing_decisions");
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: "org-1",
        bucket_code: "XBC",
        chosen_user_id: "u1",
        considered: ["u1", "u2"],
        excluded: [{ user_id: "u3", reason: "criteria_miss" }],
        outcome: "booked",
        empty_pool_fallback: false,
        tier_fallback: false,
      }),
    );
  });

  it("does NOT fire the misroute alert when the chosen agent satisfies the bucket criteria", async () => {
    // chosenAttributes matches criteria → not a misroute
    await recordRoutingDecision(baseInput);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("fires the misroute alert when the chosen agent fails criteria and no fallback was applied", async () => {
    await recordRoutingDecision({
      ...baseInput,
      chosenAttributes: { debt_team: "standard" }, // does NOT match "ultra_high"
      emptyPoolFallback: false,
      tierFallback: false,
    });
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledWith(
      expect.stringContaining("XBC"),
      expect.any(Number),
      expect.stringContaining("bk-1"),
    );
  });

  it("does NOT fire the alert when emptyPoolFallback is true (intentional fallback)", async () => {
    await recordRoutingDecision({
      ...baseInput,
      chosenAttributes: { debt_team: "standard" }, // would be a misroute, but fallback shields it
      emptyPoolFallback: true,
      tierFallback: false,
    });
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("does NOT fire the alert when tierFallback is true (intentional tier-drop)", async () => {
    await recordRoutingDecision({
      ...baseInput,
      chosenAttributes: { debt_team: "standard" },
      emptyPoolFallback: false,
      tierFallback: true,
    });
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("resolves without throwing even when the DB insert rejects (best-effort)", async () => {
    insert.mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      recordRoutingDecision({ ...baseInput, chosenAttributes: null }),
    ).resolves.toBeUndefined();
  });
});
