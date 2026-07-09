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

function flagFor(d: number) {
  return d <= 0 ? "none" : d === 1 ? "spof" : d === 2 ? "thin" : "ok";
}

function tier(over: Partial<TierDepth> & { code: string; depth: number }): TierDepth {
  // effectiveDepth defaults to roster depth (nobody out) unless overridden.
  const effectiveDepth = over.effectiveDepth ?? over.depth;
  return {
    code: over.code,
    name: over.name ?? `Tier ${over.code}`,
    depth: over.depth,
    effectiveDepth,
    outCount: over.outCount ?? over.depth - effectiveDepth,
    soleAgentName: over.soleAgentName ?? (over.depth === 1 ? "Tyler Moffett" : null),
    hasWorkingFallback: over.hasWorkingFallback ?? false,
    flag: over.flag ?? flagFor(over.depth),
    effectiveFlag: over.effectiveFlag ?? flagFor(effectiveDepth),
    agents: over.agents ?? [],
  };
}

describe("selectThinTiers", () => {
  it("picks tiers whose EFFECTIVE depth is spof (1) or thin (2)", () => {
    const depths = [
      tier({ code: "520", depth: 1 }),
      tier({ code: "420", depth: 2 }),
      tier({ code: "320", depth: 3 }), // ok
      tier({ code: "120", depth: 7 }), // ok
    ];
    expect(selectThinTiers(depths).map((t) => t.code)).toEqual(["520", "420"]);
  });

  it("#738: fires on a roster-deep tier that is effectively thin today (agents on time off)", () => {
    // Roster depth 4 (would read OK), but 2 are out today -> effective 2 (thin).
    const depths = [tier({ code: "311", depth: 4, effectiveDepth: 2 })];
    const picked = selectThinTiers(depths);
    expect(picked.map((t) => t.code)).toEqual(["311"]);
    expect(picked[0].effectiveFlag).toBe("thin");
  });

  it("#738: excludes an effectively-empty tier (a live dead-end is the availability probe's job)", () => {
    // Roster 3 but everyone's out today -> effective 0 -> not a staffing nudge.
    const depths = [tier({ code: "311", depth: 3, effectiveDepth: 0 }), tier({ code: "520", depth: 1 })];
    expect(selectThinTiers(depths).map((t) => t.code)).toEqual(["520"]);
  });

  it("excludes roster depth-0 tiers (structurally empty, handled by the availability probe)", () => {
    const depths = [tier({ code: "999", depth: 0 }), tier({ code: "520", depth: 1 })];
    expect(selectThinTiers(depths).map((t) => t.code)).toEqual(["520"]);
  });

  it("returns an empty list when every tier is adequately staffed today", () => {
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

  it("#738: spells out roster vs available-today when agents are on time off", () => {
    const msg = formatThinTierNotice([
      tier({ code: "311", name: "High | Achieve", depth: 4, effectiveDepth: 1, outCount: 3 }),
    ]);
    expect(msg).toContain("4 on the roster");
    expect(msg).toContain("1 agent available today");
    expect(msg).toContain("3 on time off");
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
