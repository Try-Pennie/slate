import { describe, it, expect, vi, beforeEach } from "vitest";

// #525: the scheduled booking-smoke canary stamps this endpoint on every
// successful run, so a schedule that silently stops firing stops stamping and the
// lane-watchdog can page. Auth reuses the booking-API Bearer key (same trust
// level as the smoke run itself): 503 when no key is configured, 401 for a wrong
// key, and only a valid key records the `smoke-canary` heartbeat.

const env = vi.hoisted(() => ({
  bookingApiKeyPrimary: vi.fn(() => ""),
  bookingApiKeySecondary: vi.fn(() => ""),
}));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);

import { POST } from "./route";

function post(authorization?: string) {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return POST(new Request("http://localhost/api/smoke/heartbeat", { method: "POST", headers }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  env.bookingApiKeyPrimary.mockReturnValue("");
  env.bookingApiKeySecondary.mockReturnValue("");
  heartbeat.recordHeartbeat.mockResolvedValue(undefined);
});

describe("POST /api/smoke/heartbeat (#525)", () => {
  it("returns 503 (disabled) and stamps nothing when no key is configured", async () => {
    const res = await post("Bearer anything");
    expect(res.status).toBe(503);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("returns 401 and stamps nothing for a wrong key", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    const res = await post("Bearer wrong");
    expect(res.status).toBe(401);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header is missing", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    const res = await post();
    expect(res.status).toBe(401);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("stamps the smoke-canary heartbeat and returns 200 on a valid key", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret");
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("smoke-canary");
  });

  it("authenticates the secondary key too (zero-downtime rotation)", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("old-secret");
    env.bookingApiKeySecondary.mockReturnValue("new-secret");
    const res = await post("Bearer new-secret");
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("smoke-canary");
  });
});
