import { describe, it, expect, vi, beforeEach } from "vitest";

// #597: allowRequest fails OPEN when the rate_limit_hit RPC errors. That is a
// DELIBERATE choice (a limiter hiccup must never block a real customer's booking,
// and verify-on-book plus the unique-slot index still bound the damage), but it was
// SILENT: the only signal was a console.error, and Cloudflare does not capture those
// in this project. So the limiter could switch itself off across every endpoint and
// nothing, anywhere, would say so.
//
// Fail open, but fail LOUD.

const rpc = vi.hoisted(() => vi.fn());
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
);

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc }) }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: {} }) }));

import { allowRequest } from "./rate-limit";
import type { RateLimitRule } from "@/lib/rate-limit-core";

const RULES: RateLimitRule[] = [
  { prefix: "test:m", windowSeconds: 60, max: 5 },
  { prefix: "test:h", windowSeconds: 3600, max: 50 },
];

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: true, error: null });
});

describe("allowRequest (#597)", () => {
  it("allows a request under the limit", async () => {
    await expect(allowRequest("1.2.3.4", RULES)).resolves.toBe(true);
  });

  it("blocks when a rule is exceeded", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(allowRequest("1.2.3.4", RULES)).resolves.toBe(false);
  });

  // The failure path. Before this, a broken limiter was indistinguishable from a
  // working one.
  it("ALERTS when the limiter itself fails, instead of silently switching off", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "relation does not exist" } });

    const allowed = await allowRequest("1.2.3.4", RULES);

    // Still fails open: a limiter outage must not block real bookings.
    expect(allowed).toBe(true);
    // But it is no longer silent.
    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    expect(text).toMatch(/rate limit/i);
    // The message has to name the failure or nobody can act on it.
    expect(text).toMatch(/relation does not exist/);
  });

  // The alert is best effort. It writes to alert_state, so the very outage that broke
  // the limiter can break the alert too. If that throws into allowRequest, a limiter
  // failure becomes a BOOKING failure, which is the opposite of failing open, and far
  // worse than the problem being fixed.
  it("still allows the request when the alert itself throws", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    sendThrottledAlert.mockRejectedValueOnce(new Error("alert store unreachable"));

    await expect(allowRequest("1.2.3.4", RULES)).resolves.toBe(true);
  });
});
