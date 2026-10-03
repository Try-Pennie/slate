import { describe, it, expect, vi, beforeEach } from "vitest";

// #3142: a refused credential is throttled per address, on the failure path only.
const bearerFailureWithinLimit = vi.hoisted(() => vi.fn(async (_ip: string) => true));
vi.mock("@/lib/rate-limit", async () => {
  const core = await import("@/lib/rate-limit-core");
  return { clientIp: core.clientIp, bearerFailureWithinLimit };
});

import { refuseCredential } from "./bearer-failure";

const headers = new Headers({ "cf-connecting-ip": "203.0.113.9" });
const unauthorized = () => new Response("unauthorized", { status: 401 });

beforeEach(() => {
  bearerFailureWithinLimit.mockReset();
  bearerFailureWithinLimit.mockResolvedValue(true);
});

describe("refuseCredential (#3142)", () => {
  it("answers with the route's own refusal under the ceiling", async () => {
    const res = await refuseCredential(headers, unauthorized);
    expect(res.status).toBe(401);
    expect(bearerFailureWithinLimit).toHaveBeenCalledWith("203.0.113.9");
  });

  it("answers 429 with a retry hint past it, and never builds the route's refusal", async () => {
    bearerFailureWithinLimit.mockResolvedValue(false);
    const refusal = vi.fn(unauthorized);
    const res = await refuseCredential(headers, refusal);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(refusal).not.toHaveBeenCalled();
  });
});
