import { describe, it, expect, vi } from "vitest";
import {
  AGENTS_WITHOUT_ROUTING_KEY,
  findUnroutableAgents,
  formatAttributeGapNotice,
  hasRoutingAttributes,
  runAttributeCoverageCheck,
  type UnroutableAgent,
} from "@/lib/monitor/attribute-coverage";
import type { Attributes } from "@/lib/db/types";

describe("hasRoutingAttributes", () => {
  it("is false for null, empty object, and empty values", () => {
    expect(hasRoutingAttributes(null)).toBe(false);
    expect(hasRoutingAttributes({})).toBe(false);
    expect(hasRoutingAttributes({ debt_team: [], role: "" })).toBe(false);
    expect(hasRoutingAttributes({ debt_team: null as unknown as string })).toBe(false);
  });
  it("is true when any usable attribute is present", () => {
    expect(hasRoutingAttributes({ role: "sales_agent" })).toBe(true);
    expect(hasRoutingAttributes({ debt_team: ["ultra_high"] })).toBe(true);
    expect(hasRoutingAttributes({ backend_service: true })).toBe(true);
  });
});

describe("findUnroutableAgents", () => {
  const agents: { id: string; name: string | null; email: string | null; attributes: Attributes | null }[] = [
    { id: "a", name: "A", email: "a@ex.com", attributes: {} },
    { id: "b", name: "B", email: "b@ex.com", attributes: { role: "sales_agent" } },
    { id: "c", name: "C", email: "c@ex.com", attributes: {} },
  ];
  it("flags agents with no attributes and no manual membership", () => {
    const out = findUnroutableAgents(agents, new Set());
    expect(out.map((a) => a.id)).toEqual(["a", "c"]);
  });
  it("does not flag an attribute-less agent who is a manual member", () => {
    const out = findUnroutableAgents(agents, new Set(["c"]));
    expect(out.map((a) => a.id)).toEqual(["a"]);
  });
  it("never flags an agent who has attributes", () => {
    const out = findUnroutableAgents(agents, new Set());
    expect(out.map((a) => a.id)).not.toContain("b");
  });
});

describe("formatAttributeGapNotice", () => {
  it("returns empty string when nobody is unroutable", () => {
    expect(formatAttributeGapNotice([])).toBe("");
  });
  it("names the agents and caps the list with a 'more' suffix", () => {
    const many: UnroutableAgent[] = Array.from({ length: 10 }, (_, i) => ({
      id: `id${i}`,
      name: `Agent ${i}`,
      email: `a${i}@ex.com`,
    }));
    const notice = formatAttributeGapNotice(many);
    expect(notice).toContain("10 bookable agent(s)");
    expect(notice).toContain("(and 2 more)");
    expect(notice).toContain("Agent 0 (a0@ex.com)");
  });
});

describe("runAttributeCoverageCheck", () => {
  it("does not notify when nobody is unroutable", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await runAttributeCoverageCheck({
      loadUnroutableAgents: async () => [],
      notify,
      cooldownMs: 1000,
    });
    expect(res.unroutable).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
  it("notifies with the throttle key when agents are unroutable", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await runAttributeCoverageCheck({
      loadUnroutableAgents: async () => [{ id: "a", name: "A", email: "a@ex.com" }],
      notify,
      cooldownMs: 1000,
    });
    expect(res.unroutable).toBe(1);
    expect(notify).toHaveBeenCalledWith(AGENTS_WITHOUT_ROUTING_KEY, 1000, expect.stringContaining("1 bookable"));
  });
  it("swallows a notify failure so the monitor tick never fails", async () => {
    const notify = vi.fn().mockRejectedValue(new Error("slack down"));
    await expect(
      runAttributeCoverageCheck({
        loadUnroutableAgents: async () => [{ id: "a", name: "A", email: "a@ex.com" }],
        notify,
        cooldownMs: 1000,
      }),
    ).resolves.toEqual({ unroutable: 1 });
  });
});
