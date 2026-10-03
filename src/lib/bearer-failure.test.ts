import { describe, it, expect, vi, beforeEach } from "vitest";

// #3142: a refused credential is throttled per address, on the failure path only.
const bearerFailureWithinLimit = vi.hoisted(() => vi.fn(async (_ip: string) => true));
vi.mock("@/lib/rate-limit", async () => {
  const core = await import("@/lib/rate-limit-core");
  return { clientIp: core.clientIp, bearerFailureWithinLimit };
});

import { refuseCredential, refuseBearerAuth, refuseCronSecret } from "./bearer-failure";

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

describe("refuseBearerAuth (#3142)", () => {
  it("throttles a refused credential", async () => {
    bearerFailureWithinLimit.mockResolvedValue(false);
    const res = await refuseBearerAuth(headers, { status: 401, error: "unauthorized" });
    expect(res.status).toBe(429);
  });

  it("answers an unset key as is, since that is our deployment rather than a caller", async () => {
    const res = await refuseBearerAuth(headers, { status: 503, error: "not configured" });
    expect(res.status).toBe(503);
    expect(bearerFailureWithinLimit).not.toHaveBeenCalled();
  });
});

describe("refuseCronSecret (#3174)", () => {
  it("throttles a refused cron secret from an outside address", async () => {
    bearerFailureWithinLimit.mockResolvedValue(false);
    const res = await refuseCronSecret(headers, unauthorized);
    expect(res.status).toBe(429);
    expect(bearerFailureWithinLimit).toHaveBeenCalledWith("203.0.113.9");
  });

  it("answers with the route's own refusal under the ceiling", async () => {
    const res = await refuseCronSecret(headers, unauthorized);
    expect(res.status).toBe(401);
  });

  it("never counts or throttles the Worker's own scheduled request, which carries no address", async () => {
    bearerFailureWithinLimit.mockResolvedValue(false);
    // What the Worker's dispatcher sends (worker/lane-run.ts): a bearer and a tick id, and
    // no client address, because the request is handed to the app in process and never
    // crosses the network where Cloudflare would stamp one.
    const scheduled = new Headers({ authorization: "Bearer stale", "x-slate-tick-id": "abc" });
    const res = await refuseCronSecret(scheduled, unauthorized);
    expect(res.status).toBe(401);
    expect(bearerFailureWithinLimit).not.toHaveBeenCalled();
  });
});
