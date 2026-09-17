import { describe, it, expect, vi } from "vitest";
import {
  selectThinTiers,
  formatThinTierNotice,
  runThinTierStaffingCheck,
  THIN_TIER_STAFFING_KEY,
} from "./thin-tier";
import { debtTierDepths, type TierDepth } from "@/lib/routing/staffing-depth";

// #569 shipped this as a whisper about thinly staffed POOLS, and #2505 changed the
// unit to the DEBT TIER. A Beyond pool sitting at one agent was named every day
// while its debt tier held eighty four people and every lead asking for it was
// served, so the whisper reported a problem nobody had. Since #2486 the ladder
// tries every bucket in a tier before dropping one, so a thin pool inside a
// staffed tier strands nobody; the per pool depth stays on `/admin/tiers`, which
// is the screen somebody goes to in order to look.

function flagFor(d: number) {
  return d <= 0 ? "none" : d === 1 ? "spof" : d === 2 ? "thin" : "ok";
}

/** One POOL row, as the depth loader produces them. */
function pool(
  over: Partial<TierDepth> & { code: string; agents: { id: string; name: string; out?: boolean }[] },
): TierDepth {
  const agents = over.agents.map((a) => ({ id: a.id, name: a.name, out: a.out ?? false }));
  const depth = agents.length;
  const effectiveDepth = agents.filter((a) => !a.out).length;
  return {
    code: over.code,
    name: over.name ?? `Tier ${over.code}`,
    depth,
    effectiveDepth,
    outCount: depth - effectiveDepth,
    soleAgentName: depth === 1 ? (agents[0]?.name ?? null) : null,
    hasWorkingFallback: over.hasWorkingFallback ?? false,
    flag: flagFor(depth),
    effectiveFlag: flagFor(effectiveDepth),
    agents,
    poolKey: over.poolKey ?? `pool-${over.code}`,
    poolLabel: over.poolLabel ?? null,
  };
}

const agent = (id: string, out = false) => ({ id, name: `Agent ${id}`, out });

describe("debtTierDepths (#2505)", () => {
  it("counts DISTINCT agents across a tier's pools, never the sum", () => {
    // The real shape: the unconstrained pool holds everyone in the tier, and the
    // Achieve pool holds the same people again. Summing would report six.
    const rows = [
      pool({ code: "511", agents: [agent("a"), agent("b"), agent("c")] }),
      pool({ code: "531", agents: [agent("a"), agent("b"), agent("c")] }),
    ];
    const [tier5] = debtTierDepths(rows);
    expect(tier5.depth).toBe(3);
    expect(tier5.tier).toBe("5");
  });

  it("takes the union when the pools genuinely differ", () => {
    const rows = [
      pool({ code: "511", agents: [agent("a"), agent("b")] }),
      pool({ code: "521", agents: [agent("c")] }),
    ];
    expect(debtTierDepths(rows)[0].depth).toBe(3);
  });

  it("discounts who is out today, distinctly, and keeps both numbers", () => {
    const rows = [
      pool({ code: "511", agents: [agent("a"), agent("b", true), agent("c", true)] }),
      // The same two absences seen again through a second pool must not be
      // counted twice.
      pool({ code: "531", agents: [agent("b", true), agent("c", true)] }),
    ];
    const [t] = debtTierDepths(rows);
    expect(t.depth).toBe(3);
    expect(t.outCount).toBe(2);
    expect(t.effectiveDepth).toBe(1);
  });

  it("orders thinnest first, so the tier in most trouble leads the notice", () => {
    const rows = [
      pool({ code: "111", agents: [agent("a"), agent("b"), agent("c"), agent("d")] }),
      pool({ code: "511", agents: [agent("e")] }),
      pool({ code: "311", agents: [agent("f"), agent("g")] }),
    ];
    expect(debtTierDepths(rows).map((t) => t.tier)).toEqual(["5", "3", "1"]);
  });

  it("names the tier from the shared routing vocabulary, not the bucket's own name", () => {
    const [t] = debtTierDepths([pool({ code: "511", name: "Ultra High | Both", agents: [agent("a")] })]);
    expect(t.name).toBe("Ultra High");
    expect(t.soleAgentName).toBe("Agent a");
  });

  it("leaves out a bucket whose code is not an XBC code rather than filing it under a digit it lacks", () => {
    expect(debtTierDepths([pool({ code: "SMOKE", agents: [agent("a")] })])).toEqual([]);
  });
});

describe("selectThinTiers", () => {
  const tierOf = (n: number) =>
    debtTierDepths([
      pool({ code: "511", agents: Array.from({ length: n }, (_, i) => agent(`a${i}`)) }),
    ])[0];

  it("picks a tier resting on one or two agents", () => {
    expect(selectThinTiers([tierOf(1)])).toHaveLength(1);
    expect(selectThinTiers([tierOf(2)])).toHaveLength(1);
  });

  it("leaves a tier of three or more alone, which is today's whole roster", () => {
    // Measured 2026-09-17: the thinnest live tier is Ultra High at 5. So this
    // whisper is silent in production, and the cases above are the only proof it
    // can still fire (L1).
    expect(selectThinTiers([tierOf(3)])).toHaveLength(0);
    expect(selectThinTiers([tierOf(5)])).toHaveLength(0);
  });

  it("leaves an EMPTY tier to the page that owns it, so the two do not double up", () => {
    // A tier with nobody is `empty_tier:<digit>`, which pages. Whispering about it
    // here as well would tell the same person the same thing twice, in two voices.
    expect(selectThinTiers([tierOf(0)])).toHaveLength(0);
  });
});

describe("formatThinTierNotice", () => {
  const thin = (code: string, n: number, out = 0) =>
    debtTierDepths([
      pool({
        code,
        // Names carry no digits from the code, so "does not name a bucket code"
        // cannot pass or fail on the fixture's own spelling.
        agents: Array.from({ length: n }, (_, i) => agent(`p${i}`, i < out)),
      }),
    ])[0];

  it("names the debt tier in words, never a bucket code", () => {
    const msg = formatThinTierNotice([thin("511", 1)]);
    expect(msg).toContain("Ultra High");
    expect(msg).not.toContain("511");
    expect(msg).toMatch(/^1 debt tier is/);
  });

  it("says when a tier is deep on the roster but thin today, with both numbers", () => {
    const msg = formatThinTierNotice([thin("411", 5, 3)]);
    expect(msg).toContain("5 on the roster");
    expect(msg).toContain("3 out today");
  });

  it("names the sole agent when a tier rests on one person", () => {
    expect(formatThinTierNotice([thin("511", 1)])).toContain("Agent p0");
  });

  it("lists every thin tier, because there are only ever five", () => {
    // The pool version capped at eight names and hid the rest behind "(and N
    // more)". At this unit the whole list always fits, so nothing can be hidden.
    const msg = formatThinTierNotice([thin("511", 1), thin("411", 2), thin("311", 2)]);
    expect(msg).not.toContain("more)");
    expect(msg).toMatch(/^3 debt tiers are/);
    expect(msg.split("\n")).toHaveLength(4);
  });

  it("returns an empty string for no thin tiers so the cron never posts a spurious notice", () => {
    expect(formatThinTierNotice([])).toBe("");
  });

  it("carries no dashes or emoji, and does not open with the product's name", () => {
    const msg = formatThinTierNotice([thin("511", 1), thin("411", 2)]);
    expect(msg).not.toMatch(/[\u2014\u2013]/);
    expect(msg).not.toMatch(/^Slate\b/);
    expect(msg).not.toMatch(/undefined|NaN|\[object Object\]/);
  });
});

describe("runThinTierStaffingCheck (cron wiring)", () => {
  const rows = (n: number) => [
    pool({ code: "511", agents: Array.from({ length: n }, (_, i) => agent(`a${i}`)) }),
  ];

  it("whispers the thin tiers through notify on the given cooldown and returns the count", async () => {
    const notify = vi.fn<(key: string, cooldownMs: number, text: string) => Promise<void>>(
      async () => {},
    );
    const count = await runThinTierStaffingCheck({
      loadDepths: async () => [
        ...rows(1),
        pool({ code: "111", agents: [agent("b"), agent("c"), agent("d")] }),
      ],
      notify,
      cooldownMs: 24 * 60 * 60_000,
    });
    expect(count).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    const [key, cooldownMs, text] = notify.mock.calls[0];
    expect(key).toBe(THIN_TIER_STAFFING_KEY);
    expect(cooldownMs).toBe(24 * 60 * 60_000);
    expect(text).toContain("Ultra High");
    // And the healthy tier is not named, so the notice is about what is thin.
    expect(text).not.toContain("Low");
  });

  it("does NOT notify when no tier is thin (no spurious post), returns 0", async () => {
    const notify = vi.fn(async () => {});
    const count = await runThinTierStaffingCheck({
      loadDepths: async () => rows(5),
      notify,
      cooldownMs: 1000,
    });
    expect(count).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("#1629: an unreadable roster propagates, it does NOT report zero thin tiers", async () => {
    const notify = vi.fn(async () => {});
    // What loadTierDepths does now on an unreadable table. Before #1629 it
    // resolved [] here, this returned 0, and the cycle line said "0 thin tier(s)"
    // off a read that never ran. The monitor lane's own `steps.run(..., null, ...)`
    // boundary turns this rejection into a recorded step failure and a null count.
    await expect(
      runThinTierStaffingCheck({
        loadDepths: async () => {
          throw new Error("read failed [staffing depth buckets]: connection reset");
        },
        notify,
        cooldownMs: 1000,
      }),
    ).rejects.toThrow(/staffing depth buckets/);
    // And nothing is whispered about a roster nobody managed to read.
    expect(notify).not.toHaveBeenCalled();
  });

  it("swallows a notify failure so a flaky Slack can't fail the monitor tick", async () => {
    const notify = vi.fn(async () => {
      throw new Error("slack 503");
    });
    // Must resolve (not reject) despite the throw, and still report the count.
    await expect(
      runThinTierStaffingCheck({
        loadDepths: async () => rows(1),
        notify,
        cooldownMs: 1000,
      }),
    ).resolves.toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
