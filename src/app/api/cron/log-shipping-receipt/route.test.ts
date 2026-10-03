import { describe, it, expect, vi, beforeEach } from "vitest";

// #3182: where Slate's `LogShippingReceipt` entrypoint stamps the receipt the tail
// worker hands over each time Better Stack accepts a cron tick's records. The
// decision and the forwarding are pinned offline in
// scripts/test-log-shipping-receipt.ts; this is the route glue: the cron bearer
// first, and exactly the lane the watchdog bounds.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async (_lane: string) => {}) }));

// #3174: a refused bearer goes through the shared failed credential throttle, like
// every other route that checks the cron secret.
const bearer = vi.hoisted(() => ({
  refuseCronSecret: vi.fn(async (_h: Headers, refusal: () => Response) => refusal()),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
vi.mock("@/lib/bearer-failure", () => bearer);

import { POST } from "./route";
import { LOG_SHIPPING_LANE, LOG_SHIPPING_STALE_BOUNDS_MS } from "@/lib/monitor/health";

function req() {
  return new Request("https://slate.trypennie.app/api/cron/log-shipping-receipt", {
    method: "POST",
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/cron/log-shipping-receipt", () => {
  it("returns 401 and stamps nothing without the cron bearer, so nobody outside can keep a broken pipe looking alive", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(bearer.refuseCronSecret).toHaveBeenCalledTimes(1);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("stamps the lane the watchdog bounds, once", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledTimes(1);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith(LOG_SHIPPING_LANE);
    expect(LOG_SHIPPING_STALE_BOUNDS_MS[LOG_SHIPPING_LANE]).toBeGreaterThan(0);
  });
});
