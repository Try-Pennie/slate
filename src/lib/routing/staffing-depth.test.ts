import { describe, it, expect } from "vitest";
import {
  bucketStaffingDepths,
  staffingFlag,
  type StaffingAgent,
  type ActiveMember,
} from "./staffing-depth";
import type { Bucket } from "@/lib/db/types";

// #584/#569: a proactive per-tier bookable-agent depth view so single points of
// failure (a tier resting on one agent, e.g. Ultra High | Beyond = only Tyler)
// are visible BEFORE the tier goes empty. These pure tests pin the depth math and
// the flag thresholds; the depth MUST match how the booker resolves a pool
// (bookable + not deactivated, criteria OR active manual member, fallback-blind).

let seq = 0;
function mkBucket(partial: Partial<Bucket> & { code: string; name: string }): Bucket {
  seq += 1;
  return {
    id: `b${seq}`,
    org_id: "org1",
    event_type_id: "et1",
    assignment: "round_robin",
    criteria: {},
    routing_form_id: null,
    fallback_user_id: null,
    is_test: false,
    created_at: "2026-07-09T00:00:00Z",
    ...partial,
  };
}

function mkAgent(partial: Partial<StaffingAgent> & { id: string }): StaffingAgent {
  return {
    name: partial.id,
    attributes: {},
    bookable: true,
    deactivated_at: null,
    ...partial,
  };
}

describe("staffingFlag", () => {
  it("classifies depth into none/spof/thin/ok", () => {
    expect(staffingFlag(0)).toBe("none");
    expect(staffingFlag(1)).toBe("spof");
    expect(staffingFlag(2)).toBe("thin");
    expect(staffingFlag(3)).toBe("ok");
    expect(staffingFlag(50)).toBe("ok");
  });
});

describe("bucketStaffingDepths", () => {
  it("names the sole agent on a single-point-of-failure tier (depth 1)", () => {
    const buckets = [
      mkBucket({ code: "522", name: "Ultra High | Beyond", criteria: { debt_team: "ultra_high_beyond" } }),
    ];
    const agents = [
      mkAgent({ id: "tyler", name: "Tyler Moffett", attributes: { debt_team: "ultra_high_beyond" } }),
      mkAgent({ id: "someone", name: "Someone Else", attributes: { debt_team: "medium_beyond" } }),
    ];
    const [row] = bucketStaffingDepths(buckets, agents, []);
    expect(row.depth).toBe(1);
    expect(row.flag).toBe("spof");
    expect(row.soleAgentName).toBe("Tyler Moffett");
  });

  // #738: time-off-aware effective depth. `outUserIds` are agents on approved
  // time off today; effectiveDepth = roster depth minus those, so a roster-deep
  // tier whose agents are mostly out surfaces its hidden short-term SPOF. The
  // roster depth/flag are unchanged (the snapshot truth); effective is the risk.
  it("defaults effectiveDepth to the roster depth when nobody is out", () => {
    const buckets = [mkBucket({ code: "311", name: "High | Achieve", criteria: { debt_team: "high_achieve" } })];
    const agents = [
      mkAgent({ id: "a", attributes: { debt_team: "high_achieve" } }),
      mkAgent({ id: "b", attributes: { debt_team: "high_achieve" } }),
      mkAgent({ id: "c", attributes: { debt_team: "high_achieve" } }),
    ];
    const [row] = bucketStaffingDepths(buckets, agents, []);
    expect(row.depth).toBe(3);
    expect(row.effectiveDepth).toBe(3);
    expect(row.effectiveFlag).toBe("ok");
    expect(row.outCount).toBe(0);
  });

  it("subtracts out-today agents into a thinner effectiveDepth while roster depth stays", () => {
    const buckets = [mkBucket({ code: "311", name: "High | Achieve", criteria: { debt_team: "high_achieve" } })];
    const agents = [
      mkAgent({ id: "a", attributes: { debt_team: "high_achieve" } }),
      mkAgent({ id: "b", attributes: { debt_team: "high_achieve" } }),
      mkAgent({ id: "c", attributes: { debt_team: "high_achieve" } }),
    ];
    // Two of the three eligible agents are on approved time off today.
    const [row] = bucketStaffingDepths(buckets, agents, [], new Set(["a", "b"]));
    expect(row.depth).toBe(3);
    expect(row.flag).toBe("ok");
    expect(row.effectiveDepth).toBe(1);
    expect(row.effectiveFlag).toBe("spof");
    expect(row.outCount).toBe(2);
  });

  // #740: the drill-down needs the full eligible roster per tier, each marked
  // out-today, sorted available-first then out, name-ascending.
  it("lists the tier's eligible agents with out-today flags, available first", () => {
    const buckets = [mkBucket({ code: "311", name: "High | Achieve", criteria: { debt_team: "high_achieve" } })];
    const agents = [
      mkAgent({ id: "z", name: "Zoe Adams", attributes: { debt_team: "high_achieve" } }),
      mkAgent({ id: "a", name: "Aaron Ng", attributes: { debt_team: "high_achieve" } }),
      mkAgent({ id: "m", name: "Mia Lee", attributes: { debt_team: "high_achieve" } }),
      mkAgent({ id: "x", name: "Not Eligible", attributes: { debt_team: "low" } }),
    ];
    const [row] = bucketStaffingDepths(buckets, agents, [], new Set(["a"]));
    // Aaron is out -> sorts last; the rest available, name-ascending.
    expect(row.agents.map((a) => `${a.name}:${a.out}`)).toEqual([
      "Mia Lee:false",
      "Zoe Adams:false",
      "Aaron Ng:true",
    ]);
  });

  it("ignores out ids that are not in the tier's eligible pool", () => {
    const buckets = [mkBucket({ code: "311", name: "High | Achieve", criteria: { debt_team: "high_achieve" } })];
    const agents = [mkAgent({ id: "a", attributes: { debt_team: "high_achieve" } })];
    // "stranger" is out but not eligible for this tier, so it can't lower depth.
    const [row] = bucketStaffingDepths(buckets, agents, [], new Set(["stranger"]));
    expect(row.effectiveDepth).toBe(1);
    expect(row.outCount).toBe(0);
  });

  it("does not name an agent when the tier has more than one (depth >= 2)", () => {
    const buckets = [mkBucket({ code: "311", name: "High | Achieve | NL", criteria: { debt_team: "high_achieve" } })];
    const agents = [
      mkAgent({ id: "a", attributes: { debt_team: "high_achieve" } }),
      mkAgent({ id: "b", attributes: { debt_team: "high_achieve" } }),
    ];
    const [row] = bucketStaffingDepths(buckets, agents, []);
    expect(row.depth).toBe(2);
    expect(row.flag).toBe("thin");
    expect(row.soleAgentName).toBeNull();
  });

  it("excludes non-bookable and deactivated agents from the depth", () => {
    const buckets = [mkBucket({ code: "111", name: "Low | Achieve | NL", criteria: { debt_team: "low" } })];
    const agents = [
      mkAgent({ id: "live", attributes: { debt_team: "low" } }),
      mkAgent({ id: "unbookable", attributes: { debt_team: "low" }, bookable: false }),
      mkAgent({ id: "offboarded", attributes: { debt_team: "low" }, deactivated_at: "2026-06-01T00:00:00Z" }),
    ];
    const [row] = bucketStaffingDepths(buckets, agents, []);
    // Only the one live, bookable agent counts -> single point of failure.
    expect(row.depth).toBe(1);
    expect(row.soleAgentName).toBe("live");
  });

  it("counts active manual members but ignores members who are not routable", () => {
    const buckets = [mkBucket({ code: "121", name: "Low | Beyond | NL", criteria: {} })];
    const agents = [
      mkAgent({ id: "member-ok" }),
      mkAgent({ id: "member-off", deactivated_at: "2026-06-01T00:00:00Z" }),
    ];
    const members: ActiveMember[] = [
      { bucket_id: buckets[0].id, user_id: "member-ok" },
      { bucket_id: buckets[0].id, user_id: "member-off" }, // deactivated -> not routable
    ];
    const [row] = bucketStaffingDepths(buckets, agents, members);
    expect(row.depth).toBe(1);
    expect(row.soleAgentName).toBe("member-ok");
  });

  it("reports zero coverage and whether a working fallback is set (fallback-blind depth)", () => {
    const withFallback = mkBucket({
      code: "211",
      name: "Medium | Achieve | NL",
      criteria: { debt_team: "nobody_here" },
      fallback_user_id: "fb",
    });
    const noFallback = mkBucket({ code: "221", name: "Medium | Beyond | NL", criteria: { debt_team: "nobody_here" } });
    const agents = [mkAgent({ id: "fb", attributes: { debt_team: "something" } })];
    const rows = bucketStaffingDepths([withFallback, noFallback], agents, []);
    const a = rows.find((r) => r.code === "211")!;
    const b = rows.find((r) => r.code === "221")!;
    expect(a.depth).toBe(0);
    expect(a.flag).toBe("none");
    expect(a.hasWorkingFallback).toBe(true);
    expect(b.depth).toBe(0);
    expect(b.hasWorkingFallback).toBe(false);
  });

  it("treats a fallback pointing at a non-routable agent as no working fallback", () => {
    const bucket = mkBucket({
      code: "231",
      name: "Medium | Settle | NL",
      criteria: { debt_team: "nobody_here" },
      fallback_user_id: "gone",
    });
    const agents = [mkAgent({ id: "gone", deactivated_at: "2026-05-01T00:00:00Z" })];
    const [row] = bucketStaffingDepths([bucket], agents, []);
    expect(row.depth).toBe(0);
    expect(row.hasWorkingFallback).toBe(false);
  });

  it("excludes synthetic test buckets", () => {
    const buckets = [
      mkBucket({ code: "SMOKE", name: "Smoke test", is_test: true, criteria: { debt_team: "low" } }),
      mkBucket({ code: "111", name: "Low | Achieve | NL", criteria: { debt_team: "low" } }),
    ];
    const agents = [mkAgent({ id: "a", attributes: { debt_team: "low" } })];
    const rows = bucketStaffingDepths(buckets, agents, []);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe("111");
  });

  it("honors negated criteria (agent with the excluded value is not counted)", () => {
    const bucket = mkBucket({
      code: "311",
      name: "High | Achieve | Non-Legal",
      criteria: { debt_team: "high_achieve", "backend_service!": "beyond" },
    });
    const agents = [
      mkAgent({ id: "eligible", attributes: { debt_team: "high_achieve" } }), // backend_service unset -> passes
      mkAgent({ id: "excluded", attributes: { debt_team: "high_achieve", backend_service: "beyond" } }),
    ];
    const [row] = bucketStaffingDepths([bucket], agents, []);
    expect(row.depth).toBe(1);
    expect(row.soleAgentName).toBe("eligible");
  });

  it("sorts thinnest tiers first so single points of failure surface at the top", () => {
    const buckets = [
      mkBucket({ code: "OK", name: "Deep", criteria: { debt_team: "deep" } }),
      mkBucket({ code: "SPOF", name: "Alone", criteria: { debt_team: "alone" } }),
      mkBucket({ code: "THIN", name: "Two", criteria: { debt_team: "two" } }),
    ];
    const agents = [
      mkAgent({ id: "d1", attributes: { debt_team: "deep" } }),
      mkAgent({ id: "d2", attributes: { debt_team: "deep" } }),
      mkAgent({ id: "d3", attributes: { debt_team: "deep" } }),
      mkAgent({ id: "s1", attributes: { debt_team: "alone" } }),
      mkAgent({ id: "t1", attributes: { debt_team: "two" } }),
      mkAgent({ id: "t2", attributes: { debt_team: "two" } }),
    ];
    const rows = bucketStaffingDepths(buckets, agents, []);
    expect(rows.map((r) => r.code)).toEqual(["SPOF", "THIN", "OK"]);
  });
});
