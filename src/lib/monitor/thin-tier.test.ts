import { describe, it, expect, vi } from "vitest";
import {
  selectThinTiers,
  formatThinTierNotice,
  runThinTierStaffingCheck,
  THIN_TIER_STAFFING_KEY,
} from "./thin-tier";
import type { TierDepth } from "@/lib/routing/staffing-depth";

// #569: the proactive Slack early-warning for thinly-staffed tiers, riding the
// monitor cron. These pure tests pin WHICH tiers qualify (spof + thin only) and
// the notice wording; the depth math itself lives in staffing-depth.ts (#584).

function tier(over: Partial<TierDepth> & { code: string; depth: number }): TierDepth {
  const flag =
    over.depth <= 0 ? "none" : over.depth === 1 ? "spof" : over.depth === 2 ? "thin" : "ok";
  return {
    code: over.code,
    name: over.name ?? `Tier ${over.code}`,
    depth: over.depth,
    soleAgentName: over.soleAgentName ?? (over.depth === 1 ? "Tyler Moffett" : null),
    hasWorkingFallback: over.hasWorkingFallback ?? false,
    flag: over.flag ?? flag,
  };
}

describe("selectThinTiers", () => {
  it("picks only spof (depth 1) and thin (depth 2) tiers", () => {
    const depths = [
      tier({ code: "520", depth: 1 }),
      tier({ code: "420", depth: 2 }),
      tier({ code: "320", depth: 3 }), // ok
      tier({ code: "120", depth: 7 }), // ok
    ];
    expect(selectThinTiers(depths).map((t) => t.code)).toEqual(["520", "420"]);
  });

  it("excludes depth-0 tiers (a true dead-end is the #371 availability probe's job, not a staffing nudge)", () => {
    const depths = [tier({ code: "999", depth: 0 }), tier({ code: "520", depth: 1 })];
    expect(selectThinTiers(depths).map((t) => t.code)).toEqual(["520"]);
  });

  it("returns an empty list when every tier is adequately staffed", () => {
    const depths = [tier({ code: "120", depth: 5 }), tier({ code: "220", depth: 4 })];
    expect(selectThinTiers(depths)).toEqual([]);
  });
});

describe("formatThinTierNotice", () => {
  it("names the sole agent for a single point of failure and marks a thin tier as two deep", () => {
    const msg = formatThinTierNotice([
      tier({ code: "520", name: "Ultra High | Beyond", depth: 1, soleAgentName: "Tyler Moffett" }),
      tier({ code: "420", name: "Very High | Beyond", depth: 2 }),
    ]);
    expect(msg).toContain("Slate (info):");
    expect(msg).toContain("520 (Ultra High | Beyond)");
    expect(msg).toContain("Tyler Moffett");
    expect(msg).toContain("420 (Very High | Beyond)");
    expect(msg).toContain("2 agents");
  });

  it("annotates a tier whose only cushion is a fallback as lower urgency", () => {
    const msg = formatThinTierNotice([
      tier({ code: "520", depth: 1, soleAgentName: "Tyler Moffett", hasWorkingFallback: true }),
    ]);
    expect(msg.toLowerCase()).toContain("fallback");
  });

  it("caps the listed tiers and reports the remainder", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      tier({ code: `5${i}0`, depth: 1, soleAgentName: `Agent ${i}` }),
    );
    const msg = formatThinTierNotice(many);
    expect(msg).toContain("(and 2 more)"); // ALERT_NAME_CAP = 8
  });

  it("returns an empty string for no thin tiers so the cron never posts a spurious notice", () => {
    expect(formatThinTierNotice([])).toBe("");
  });
});

describe("runThinTierStaffingCheck (cron wiring)", () => {
  it("whispers the thin tiers through notify on the given cooldown and returns the count", async () => {
    const notify = vi.fn<(key: string, cooldownMs: number, text: string) => Promise<void>>(
      async () => {},
    );
    const count = await runThinTierStaffingCheck({
      loadDepths: async () => [tier({ code: "520", depth: 1 }), tier({ code: "120", depth: 6 })],
      notify,
      cooldownMs: 24 * 60 * 60_000,
    });
    expect(count).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    const [key, cooldownMs, text] = notify.mock.calls[0];
    expect(key).toBe(THIN_TIER_STAFFING_KEY);
    expect(cooldownMs).toBe(24 * 60 * 60_000);
    expect(text).toContain("520");
  });

  it("does NOT notify when no tier is thin (no spurious post), returns 0", async () => {
    const notify = vi.fn(async () => {});
    const count = await runThinTierStaffingCheck({
      loadDepths: async () => [tier({ code: "120", depth: 5 })],
      notify,
      cooldownMs: 1000,
    });
    expect(count).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("swallows a notify failure so a flaky Slack can't fail the monitor tick", async () => {
    const notify = vi.fn(async () => {
      throw new Error("slack 503");
    });
    // Must resolve (not reject) despite the throw, and still report the count.
    await expect(
      runThinTierStaffingCheck({
        loadDepths: async () => [tier({ code: "520", depth: 1 })],
        notify,
        cooldownMs: 1000,
      }),
    ).resolves.toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
