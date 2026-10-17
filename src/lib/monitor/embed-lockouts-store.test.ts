import { describe, it, expect, vi, beforeEach } from "vitest";

// #1727: the read behind the embed cap signals, how many keys a cap is refusing
// right now. The rule that matters is the failure path: a failed count must reach
// the monitor step as a throw, never as zero, because zero would clear a page about
// people who are still locked out.

const chain = vi.hoisted(() => {
  const calls: unknown[][] = [];
  const result = { value: { count: 0 as number | null, error: null as { message: string } | null } };
  const b: Record<string, unknown> = {};
  for (const method of ["select", "like", "gt"]) {
    b[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return b;
    };
  }
  // The builder is awaited directly at the end of the chain.
  b.then = (resolve: (v: unknown) => void) => resolve(result.value);
  return { calls, result, builder: b };
});
const from = vi.hoisted(() => vi.fn(() => chain.builder));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import { countLockedOutKeys } from "./embed-lockouts-store";
import { BOOKING_CONTACT_HOURLY_RATE_RULES } from "@/lib/rate-limit-core";

const NOW = Date.UTC(2026, 9, 16, 15, 0, 0);
const rule = BOOKING_CONTACT_HOURLY_RATE_RULES[0]!;

beforeEach(() => {
  chain.calls.length = 0;
  chain.result.value = { count: 0, error: null };
  from.mockClear();
});

describe("countLockedOutKeys (#1727)", () => {
  it("asks for a server side count of the rule's keys over its limit in a live window", async () => {
    chain.result.value = { count: 4, error: null };
    await expect(countLockedOutKeys(rule, NOW)).resolves.toBe(4);
    expect(from).toHaveBeenCalledWith("rate_limits");
    expect(chain.calls).toEqual([
      ["select", "key", { count: "exact", head: true }],
      ["like", "key", "book:contact:h:%"],
      ["gt", "count", rule.max],
      ["gt", "window_start", new Date(NOW - rule.windowSeconds * 1000).toISOString()],
    ]);
  });

  it("throws on a failed count rather than answering zero", async () => {
    chain.result.value = { count: null, error: { message: "statement timeout" } };
    await expect(countLockedOutKeys(rule, NOW)).rejects.toThrow(/statement timeout/);
  });
});
