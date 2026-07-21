import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP-level wiring for the routing-preview endpoint (#596/#961). The per-minute
// burst window runs at the Cloudflare edge (routingWithinLimit) with no DB
// round-trip; the hourly cap stays in the DB (allowRequest). This pins the order
// (edge first, then DB) and the 429 behaviour; resolveRouting is mocked so this
// exercises only the route glue.

const rateLimit = vi.hoisted(() => ({
  routingWithinLimit: vi.fn(async (_ip: string) => true),
  allowRequest: vi.fn(async (_key: string, _rules: unknown) => true),
  clientIp: (headers: Headers) =>
    headers.get("cf-connecting-ip")?.trim() ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown",
  ROUTING_HOURLY_RATE_RULES: [{ prefix: "routing:h", windowSeconds: 3600, max: 200 }],
}));
const service = vi.hoisted(() => ({ resolveRouting: vi.fn() }));

vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/availability/service", () => service);

import { POST } from "./route";

function post(xbc?: unknown, ip = "203.0.113.7") {
  return POST(
    new Request("http://localhost/api/routing", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json", "cf-connecting-ip": ip }),
      body: JSON.stringify(xbc === undefined ? {} : { xbc }),
    }) as never,
  );
}

const ROUTING = {
  bucket: { code: "411" },
  eligibleIds: ["u1", "u2"],
  routedAgentId: "u1",
  fallbackApplied: false,
};

describe("POST /api/routing (#596/#961)", () => {
  beforeEach(() => {
    rateLimit.routingWithinLimit.mockClear();
    rateLimit.routingWithinLimit.mockResolvedValue(true);
    rateLimit.allowRequest.mockClear();
    rateLimit.allowRequest.mockResolvedValue(true);
    service.resolveRouting.mockReset();
    service.resolveRouting.mockResolvedValue(ROUTING);
  });

  it("returns the eligible pool + routed pick for a known bucket", async () => {
    const res = await post("411");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      bucket: { code: "411" },
      eligibleAgentIds: ["u1", "u2"],
      routedAgentId: "u1",
      fallbackApplied: false,
    });
    // Both throttles keyed on the same client IP.
    expect(rateLimit.routingWithinLimit).toHaveBeenCalledWith("203.0.113.7");
    expect(rateLimit.allowRequest).toHaveBeenCalledWith(
      "203.0.113.7",
      rateLimit.ROUTING_HOURLY_RATE_RULES,
    );
  });

  it("429s on the EDGE per-minute limiter without touching the DB hourly cap", async () => {
    rateLimit.routingWithinLimit.mockResolvedValue(false);
    const res = await post("411");
    expect(res.status).toBe(429);
    expect(rateLimit.allowRequest).not.toHaveBeenCalled();
    expect(service.resolveRouting).not.toHaveBeenCalled();
  });

  it("429s on the DB hourly cap when the edge window is fine", async () => {
    rateLimit.allowRequest.mockResolvedValue(false);
    const res = await post("411");
    expect(res.status).toBe(429);
    expect(rateLimit.routingWithinLimit).toHaveBeenCalled();
    expect(service.resolveRouting).not.toHaveBeenCalled();
  });

  it("400s a missing xbc (after the throttle passes)", async () => {
    const res = await post(undefined);
    expect(res.status).toBe(400);
  });

  it("404s an unknown bucket", async () => {
    service.resolveRouting.mockResolvedValue(null);
    const res = await post("999");
    expect(res.status).toBe(404);
  });
});
