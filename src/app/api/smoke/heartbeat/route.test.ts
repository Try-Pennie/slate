import { describe, it, expect, vi, beforeEach } from "vitest";

// #525: the scheduled booking-smoke canary stamps this endpoint on every
// successful run, so a schedule that silently stops firing stops stamping and the
// lane-watchdog can page. Auth reuses the booking-API Bearer key (same trust
// level as the smoke run itself): 503 when no key is configured, 401 for a wrong
// key, and only a valid key records the `smoke-canary` heartbeat.

const env = vi.hoisted(() => ({
  bookingApiKeyFor: vi.fn((_caller: string, _slot: string) => ""),
}));
// #2854: the smoke endpoints take the canary's own key and nothing else, so the key
// these tests authenticate with is the canary's; a partner's key is configured
// beside it in the refusal test to prove it is refused.
const canaryKey = vi.hoisted(() => ({ primary: vi.fn(() => ""), secondary: vi.fn(() => "") }));
const canaryKeyFor = (caller: string, slot: string) =>
  caller !== "canary" ? "" : slot === "primary" ? canaryKey.primary() : canaryKey.secondary();
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));


vi.mock("@/lib/env", () => env);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);

import { POST } from "./route";

function post(authorization?: string, lane?: string) {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  const url =
    "http://localhost/api/smoke/heartbeat" + (lane !== undefined ? `?lane=${encodeURIComponent(lane)}` : "");
  return POST(new Request(url, { method: "POST", headers }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  env.bookingApiKeyFor.mockImplementation(canaryKeyFor);
  canaryKey.primary.mockReturnValue("");
  canaryKey.secondary.mockReturnValue("");
  heartbeat.recordHeartbeat.mockResolvedValue(undefined);
});

// #2645: this endpoint keeps the canary's heartbeat fresh, so it takes only the
// canary's own key. A partner key that could stamp it
// would keep a dead canary looking alive.
describe("POST /api/smoke/heartbeat caller scope (#2645)", () => {
  beforeEach(() => {
    env.bookingApiKeyFor.mockImplementation((caller: string, slot: string) =>
      slot === "primary" ? `${caller}-secret` : "",
    );
  });

  it("stamps on the canary's own key", async () => {
    const res = await post("Bearer canary-secret");
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("smoke-canary");
  });

  it("refuses a partner's key and stamps nothing", async () => {
    for (const partner of ["regal", "trypennie"]) {
      const res = await post(`Bearer ${partner}-secret`);
      expect(res.status).toBe(401);
    }
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });
});

describe("POST /api/smoke/heartbeat (#525)", () => {
  it("returns 503 (disabled) and stamps nothing when no key is configured", async () => {
    const res = await post("Bearer anything");
    expect(res.status).toBe(503);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("returns 401 and stamps nothing for a wrong key", async () => {
    canaryKey.primary.mockReturnValue("real-secret");
    const res = await post("Bearer wrong");
    expect(res.status).toBe(401);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header is missing", async () => {
    canaryKey.primary.mockReturnValue("real-secret");
    const res = await post();
    expect(res.status).toBe(401);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("stamps the smoke-canary heartbeat and returns 200 on a valid key", async () => {
    canaryKey.primary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret");
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("smoke-canary");
  });

  it("authenticates the secondary key too (zero-downtime rotation)", async () => {
    canaryKey.primary.mockReturnValue("old-secret");
    canaryKey.secondary.mockReturnValue("new-secret");
    const res = await post("Bearer new-secret");
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("smoke-canary");
  });

  // #982: the full book/reschedule/cancel pass stamps its OWN heartbeat so a
  // silently-dropped full run is no longer masked by the 30-min dry tick.
  it("stamps smoke-canary-full when lane=smoke-canary-full", async () => {
    canaryKey.primary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret", "smoke-canary-full");
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("smoke-canary-full");
  });

  // #3076: the daily dump workflow stamps its own lane once the upload is verified.
  it("stamps db-backup when lane=db-backup", async () => {
    canaryKey.primary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret", "db-backup");
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("db-backup");
  });

  it("defaults to the smoke-canary lane when no lane is given", async () => {
    canaryKey.primary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret");
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("smoke-canary");
  });

  // Security scoping: the endpoint must only stamp canary lanes. A bearer-key
  // holder stamping a real cron lane (e.g. `sync`) would keep the dead-man's
  // switch looking alive while that lane is actually dead, so an unknown lane is
  // rejected and stamps NOTHING.
  it("rejects a real cron lane with 400 and stamps nothing", async () => {
    canaryKey.primary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret", "sync");
    expect(res.status).toBe(400);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects an unknown lane with 400 and stamps nothing", async () => {
    canaryKey.primary.mockReturnValue("real-secret");
    const res = await post("Bearer real-secret", "bogus");
    expect(res.status).toBe(400);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  // Auth is checked BEFORE the lane, so a bad key on a bogus lane is still a 401
  // (do not leak which lanes are valid to an unauthenticated caller).
  it("checks auth before the lane (wrong key on a bogus lane is 401)", async () => {
    canaryKey.primary.mockReturnValue("real-secret");
    const res = await post("Bearer wrong", "bogus");
    expect(res.status).toBe(401);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });
});
